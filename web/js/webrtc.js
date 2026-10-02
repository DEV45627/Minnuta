/** Mesh WebRTC helpers for Minuta meeting rooms. */

function wsUrlForMeeting(publicId, qs) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws/meetings/${publicId}?${qs}`;
}

function candidateType(candidate) {
  const m = String(candidate?.candidate || candidate || "").match(/\btyp\s+(\w+)/i);
  return m ? m[1] : null;
}

export class MeshRoom {
  constructor({ signaling, localStream, iceServers, onRemoteStream, onPeerLeft, onPeerState }) {
    this.signaling = signaling;
    this.localStream = localStream;
    this.iceServers = iceServers || [{ urls: "stun:stun.l.google.com:19302" }];
    this.onRemoteStream = onRemoteStream;
    this.onPeerLeft = onPeerLeft;
    this.onPeerState = onPeerState;
    this.pcs = new Map();
    this.peerStates = new Map();
    this.makingOffer = new Set();
  }

  _setState(peerId, patch) {
    const prev = this.peerStates.get(peerId) || {};
    const next = { ...prev, ...patch };
    this.peerStates.set(peerId, next);
    this.onPeerState?.(peerId, next);
  }

  async ensurePc(peerId) {
    if (this.pcs.has(peerId)) return this.pcs.get(peerId);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.localStream?.getTracks().forEach((track) => pc.addTrack(track, this.localStream));
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        const typ = candidateType(ev.candidate);
        if (typ) {
          const prev = this.peerStates.get(peerId)?.candidateTypes || [];
          if (!prev.includes(typ)) {
            this._setState(peerId, { candidateTypes: [...prev, typ] });
          }
        }
        this.signaling.send({
          type: "ice_candidate",
          to: peerId,
          candidate: ev.candidate,
        });
      }
    };
    pc.ontrack = (ev) => {
      const stream = ev.streams[0];
      this.onRemoteStream?.(peerId, stream);
    };
    pc.onconnectionstatechange = () => {
      this._setState(peerId, { connection: pc.connectionState });
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
        this.closePeer(peerId);
      }
    };
    pc.oniceconnectionstatechange = () => {
      this._setState(peerId, { ice: pc.iceConnectionState });
    };
    this.pcs.set(peerId, pc);
    this._setState(peerId, {
      connection: pc.connectionState,
      ice: pc.iceConnectionState,
      candidateTypes: [],
    });
    return pc;
  }

  async call(peerId) {
    const pc = await this.ensurePc(peerId);
    this.makingOffer.add(peerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signaling.send({ type: "offer", to: peerId, sdp: pc.localDescription });
    this.makingOffer.delete(peerId);
  }

  async handleOffer(from, sdp) {
    const pc = await this.ensurePc(from);
    await pc.setRemoteDescription(sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.signaling.send({ type: "answer", to: from, sdp: pc.localDescription });
  }

  async handleAnswer(from, sdp) {
    const pc = this.pcs.get(from);
    if (!pc) return;
    await pc.setRemoteDescription(sdp);
  }

  async handleIce(from, candidate) {
    const pc = await this.ensurePc(from);
    if (candidate) await pc.addIceCandidate(candidate);
  }

  replaceVideoTrack(track) {
    for (const pc of this.pcs.values()) {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender) sender.replaceTrack(track);
    }
  }

  closePeer(peerId) {
    const pc = this.pcs.get(peerId);
    if (pc) {
      pc.close();
      this.pcs.delete(peerId);
    }
    this.peerStates.delete(peerId);
    this.onPeerLeft?.(peerId);
  }

  closeAll() {
    for (const id of [...this.pcs.keys()]) this.closePeer(id);
  }

  diagnostics() {
    return [...this.peerStates.entries()].map(([peerId, state]) => ({
      peerId,
      ...state,
    }));
  }
}

export class SignalingClient {
  constructor(publicId, { peerId, displayName, role, localStream, onRemoteStream, onMessage, onState }) {
    this.publicId = publicId;
    this.peerId = peerId;
    this.displayName = displayName;
    this.role = role;
    this.localStream = localStream;
    this.onRemoteStream = onRemoteStream;
    this.onMessage = onMessage;
    this.onState = onState;
    this.ws = null;
    this.channel = null;
    this.storageKey = `minuta_room_msg_${publicId}`;
    this.rosterKey = `minuta_room_roster_${publicId}`;
    this.isFallback = false;
    this.peerjs = null;
    this.peerJsId = null;
    this.peerJsConns = new Map();
    this.peerJsCalls = new Map();
    this.slotIndex = -1;
    this.slotTimer = null;
  }

  connect() {
    this.onState?.("connecting");
    const qs = new URLSearchParams({
      peer_id: this.peerId,
      display_name: this.displayName,
      role: this.role,
    });
    const url = wsUrlForMeeting(this.publicId, qs);

    return new Promise((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this._initFallback();
          resolve();
        }
      }, 1000);

      try {
        this.ws = new WebSocket(url);
        this.ws.onopen = () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            this.onState?.("open");
            resolve();
          }
        };
        this.ws.onmessage = (ev) => {
          try {
            this.onMessage?.(JSON.parse(ev.data));
          } catch (_) {}
        };
        this.ws.onerror = () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            this._initFallback();
            resolve();
          }
        };
        this.ws.onclose = () => {
          if (this.isFallback) return;
          this.onState?.("closed");
        };
      } catch (err) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          this._initFallback();
          resolve();
        }
      }
    });
  }

  _initFallback() {
    this.isFallback = true;
    this.onState?.("open");

    const channelName = `minuta_meeting_${this.publicId}`;
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(channelName);
      this.channel.onmessage = (ev) => this._handleFallbackMsg(ev.data);
    }

    window.addEventListener("storage", (ev) => {
      if (ev.key === this.storageKey && ev.newValue) {
        try {
          const msg = JSON.parse(ev.newValue);
          if (msg && msg._sender !== this.peerId && msg._sender !== this.peerJsId) {
            this._handleFallbackMsg(msg);
          }
        } catch (_) {}
      }
    });

    this._initPeerJS();
  }

  _initPeerJS() {
    if (window.Peer) {
      this._setupPeerJS();
      return;
    }
    try {
      const script = document.createElement("script");
      script.src = "https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js";
      script.onload = () => this._setupPeerJS();
      script.onerror = () => {
        const backupScript = document.createElement("script");
        backupScript.src = "https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js";
        backupScript.onload = () => this._setupPeerJS();
        document.head.appendChild(backupScript);
      };
      document.head.appendChild(script);
    } catch (_) {}
  }

  _setupPeerJS() {
    if (!window.Peer || this.peerjs) return;

    const maxSlots = 8;
    const trySlot = (slot) => {
      if (slot >= maxSlots) {
        const fallbackId = `minuta_${this.publicId}_${crypto.randomUUID().slice(0, 6)}`;
        this._bindPeerJsInstance(fallbackId, slot, () => {});
        return;
      }
      const candidateId = `minuta_${this.publicId}_slot${slot}`;
      this._bindPeerJsInstance(candidateId, slot, (err) => {
        if (err?.type === "unavailable-id" || err?.type === "peer-unavailable" || err?.message?.includes("taken")) {
          trySlot(slot + 1);
        }
      });
    };

    trySlot(0);
  }

  _bindPeerJsInstance(candidateId, slot, onErrorCallback) {
    try {
      const peer = new window.Peer(candidateId, {
        config: {
          iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
            { urls: "stun:stun2.l.google.com:19302" },
            { urls: "stun:stun3.l.google.com:19302" },
            { urls: "stun:global.stun.twilio.com:3478" },
          ],
        },
      });

      let registered = false;

      peer.on("open", (id) => {
        registered = true;
        this.peerjs = peer;
        this.slotIndex = slot;
        this.peerJsId = id;

        peer.on("call", (call) => {
          const streamToSend = this.localStream || new MediaStream();
          call.answer(streamToSend);
          this.peerJsCalls.set(call.peer, call);

          call.on("stream", (remoteStream) => {
            this.onRemoteStream?.(call.peer, remoteStream);
          });
          call.on("close", () => {
            this.peerJsCalls.delete(call.peer);
          });
          call.on("error", () => {
            this.peerJsCalls.delete(call.peer);
          });
        });

        peer.on("connection", (conn) => {
          conn.on("open", () => {
            try {
              conn.send({
                type: "welcome",
                roster: this._getPeerJsRoster(),
                _sender: this.peerJsId || this.peerId,
              });
            } catch (_) {}
          });
          conn.on("data", (data) => {
            if (data && data._sender) {
              this.peerJsConns.set(data._sender, conn);
            }
            if (data && data.display_name) {
              conn._displayName = data.display_name;
            }
            this._handleFallbackMsg(data);
          });
          conn.on("close", () => {
            if (conn._sender) this.peerJsConns.delete(conn._sender);
          });
        });

        this._startSlotScanner();
      });

      peer.on("error", (err) => {
        if (!registered) {
          try { peer.destroy(); } catch (_) {}
          onErrorCallback?.(err);
        }
      });
    } catch (e) {
      onErrorCallback?.(e);
    }
  }

  _getPeerJsRoster() {
    const list = [];
    for (const [id, conn] of this.peerJsConns.entries()) {
      list.push({ peer_id: id, display_name: conn._displayName || "Participant", role: "participant" });
    }
    list.push({ peer_id: this.peerJsId || this.peerId, display_name: this.displayName, role: this.role });
    return list;
  }

  _startSlotScanner() {
    if (this.slotTimer) clearInterval(this.slotTimer);

    const scan = () => {
      if (!this.peerjs || this.peerjs.destroyed) return;
      for (let s = 0; s < 8; s++) {
        if (s === this.slotIndex) continue;
        const targetSlotId = `minuta_${this.publicId}_slot${s}`;

        if (!this.peerJsConns.has(targetSlotId) || !this.peerJsConns.get(targetSlotId)?.open) {
          this._connectPeerJsSlot(targetSlotId);
        }

        if (!this.peerJsCalls.has(targetSlotId)) {
          try {
            const streamToSend = this.localStream || new MediaStream();
            const call = this.peerjs.call(targetSlotId, streamToSend);
            if (call) {
              this.peerJsCalls.set(targetSlotId, call);
              call.on("stream", (remoteStream) => {
                this.onRemoteStream?.(targetSlotId, remoteStream);
              });
              call.on("close", () => {
                this.peerJsCalls.delete(targetSlotId);
              });
              call.on("error", () => {
                this.peerJsCalls.delete(targetSlotId);
              });
            }
          } catch (_) {}
        }
      }
    };

    scan();
    this.slotTimer = setInterval(scan, 3000);
  }

  _connectPeerJsSlot(targetSlotId) {
    if (!this.peerjs) return;
    try {
      const conn = this.peerjs.connect(targetSlotId);
      conn._pending = [{
        type: "peer_joined",
        peer_id: this.peerJsId || this.peerId,
        display_name: this.displayName,
        role: this.role,
        roster: this._getPeerJsRoster(),
        _sender: this.peerJsId || this.peerId,
      }];
      conn.on("open", () => {
        this.peerJsConns.set(targetSlotId, conn);
        if (conn._pending) {
          for (const m of conn._pending) {
            try { conn.send(m); } catch (_) {}
          }
          conn._pending = [];
        }
      });
      conn.on("data", (data) => {
        if (data && data.display_name) {
          conn._displayName = data.display_name;
        }
        if (data && data._sender) {
          this.peerJsConns.set(data._sender, conn);
        }
        this._handleFallbackMsg(data);
      });
      conn.on("close", () => {
        this.peerJsConns.delete(targetSlotId);
      });
      conn.on("error", () => {
        this.peerJsConns.delete(targetSlotId);
      });
    } catch (_) {}
  }

  _handleFallbackMsg(msg) {
    if (!msg) return;
    const sender = msg._sender || msg.from || msg.peer_id;
    if (sender === this.peerId || sender === this.peerJsId) return;
    if (msg.to && msg.to !== this.peerId && msg.to !== this.peerJsId) return;

    if (msg.type === "peer_joined" || msg.type === "welcome") {
      const currentRoster = this._getPeerJsRoster();
      msg.roster = currentRoster;
    }
    this.onMessage?.(msg);
  }

  _dispatchFallbackMsg(payload) {
    const msg = { ...payload, _sender: this.peerJsId || this.peerId };
    if (this.channel) {
      try {
        this.channel.postMessage(msg);
      } catch (_) {}
    }
    try {
      localStorage.setItem(this.storageKey, JSON.stringify({ ...msg, _t: Date.now() }));
    } catch (_) {}

    for (const conn of this.peerJsConns.values()) {
      if (conn && conn.open) {
        try {
          conn.send(msg);
        } catch (_) {}
      } else if (conn) {
        if (!conn._pending) conn._pending = [];
        conn._pending.push(msg);
      }
    }
  }

  replaceVideoTrack(track) {
    if (this.localStream) {
      const senderTrack = this.localStream.getVideoTracks()[0];
      if (senderTrack) {
        this.localStream.removeTrack(senderTrack);
      }
      this.localStream.addTrack(track);
    }
    for (const call of this.peerJsCalls.values()) {
      try {
        const sender = call.peerConnection?.getSenders()?.find((s) => s.track && s.track.kind === "video");
        if (sender) sender.replaceTrack(track);
      } catch (_) {}
    }
  }

  readyStateLabel() {
    if (this.isFallback) return "open (slot " + (this.slotIndex >= 0 ? this.slotIndex : "connecting") + ")";
    if (!this.ws) return "none";
    return ["connecting", "open", "closing", "closed"][this.ws.readyState] || "unknown";
  }

  send(payload) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    } else if (this.isFallback) {
      this._dispatchFallbackMsg(payload);
    }
  }

  close() {
    if (this.slotTimer) {
      clearInterval(this.slotTimer);
      this.slotTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
    }
    if (this.channel) {
      try { this.channel.close(); } catch (_) {}
    }
    if (this.peerjs) {
      try { this.peerjs.destroy(); } catch (_) {}
    }
    if (this.isFallback) {
      this._dispatchFallbackMsg({
        type: "peer_left",
        peer_id: this.peerJsId || this.peerId,
      });
    }
  }
}

export async function fetchIceServers(meetingId) {
  try {
    const qs = meetingId ? `?meeting_id=${encodeURIComponent(meetingId)}` : "";
    const res = await fetch(`/api/webrtc/ice${qs}`);
    if (res.ok) {
      const data = await res.json();
      return data;
    }
  } catch (_) {}
  return {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
      { urls: "stun:stun3.l.google.com:19302" },
      { urls: "stun:global.stun.twilio.com:3478" },
    ],
    has_stun: true,
    has_turn: false,
  };
}
