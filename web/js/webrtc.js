/** Mesh WebRTC helpers for Minuta meeting rooms. */

function wsUrlForMeeting(publicId, qs) {
  // Derive from the page origin — works for https://domain (wss) and local http (ws).
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws/meetings/${publicId}?${qs}`;
}

function candidateType(candidate) {
  // host | srflx | prflx | relay
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
  constructor(publicId, { peerId, displayName, role, onMessage, onState }) {
    this.publicId = publicId;
    this.peerId = peerId;
    this.displayName = displayName;
    this.role = role;
    this.onMessage = onMessage;
    this.onState = onState;
    this.ws = null;
    this.channel = null;
    this.storageKey = `minuta_room_msg_${publicId}`;
    this.rosterKey = `minuta_room_roster_${publicId}`;
    this.isFallback = false;
    this.peerjs = null;
    this.peerJsConns = new Map();
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
          if (msg && msg._sender !== this.peerId) {
            this._handleFallbackMsg(msg);
          }
        } catch (_) {}
      }
    });

    let roster = this._getRoster();
    roster = roster.filter((p) => p.peer_id !== this.peerId);
    roster.push({
      peer_id: this.peerId,
      display_name: this.displayName,
      role: this.role,
    });
    this._saveRoster(roster);

    setTimeout(() => {
      const currentRoster = this._getRoster();
      this._dispatchFallbackMsg({
        type: "welcome",
        roster: currentRoster,
      });
      this._dispatchFallbackMsg({
        type: "peer_joined",
        peer_id: this.peerId,
        display_name: this.displayName,
        role: this.role,
        roster: currentRoster,
      });
    }, 100);

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
      document.head.appendChild(script);
    } catch (_) {}
  }

  _setupPeerJS() {
    if (!window.Peer) return;
    try {
      const cleanPeerId = this.peerId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
      const peerJsId = `minuta_${this.publicId}_${cleanPeerId}`;
      this.peerjs = new window.Peer(peerJsId, {
        config: {
          iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
            { urls: "stun:global.stun.twilio.com:3478" },
          ],
        },
      });

      this.peerjs.on("connection", (conn) => {
        conn.on("data", (data) => {
          if (data && data._sender) {
            this.peerJsConns.set(data._sender, conn);
          }
          this._handleFallbackMsg(data);
        });
      });

      this.peerjs.on("open", () => {
        // Broadcast presence over PeerJS to existing roster peers
        const roster = this._getRoster();
        for (const p of roster) {
          if (p.peer_id !== this.peerId) {
            this._connectPeerJs(p.peer_id);
          }
        }
      });

      this.peerjs.on("error", () => {});
    } catch (_) {}
  }

  _connectPeerJs(remotePeerId) {
    if (!this.peerjs || this.peerJsConns.has(remotePeerId)) {
      return this.peerJsConns.get(remotePeerId);
    }
    try {
      const cleanTo = remotePeerId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
      const remotePeerJsId = `minuta_${this.publicId}_${cleanTo}`;
      const conn = this.peerjs.connect(remotePeerJsId);
      conn.on("open", () => {
        this.peerJsConns.set(remotePeerId, conn);
        conn.send({
          type: "peer_joined",
          peer_id: this.peerId,
          display_name: this.displayName,
          role: this.role,
          _sender: this.peerId,
        });
      });
      conn.on("data", (data) => {
        this._handleFallbackMsg(data);
      });
      this.peerJsConns.set(remotePeerId, conn);
      return conn;
    } catch (_) {
      return null;
    }
  }

  _getRoster() {
    try {
      return JSON.parse(localStorage.getItem(this.rosterKey) || "[]");
    } catch {
      return [];
    }
  }

  _saveRoster(roster) {
    try {
      localStorage.setItem(this.rosterKey, JSON.stringify(roster));
    } catch (_) {}
  }

  _handleFallbackMsg(msg) {
    if (!msg || msg._sender === this.peerId) return;
    if (msg.to && msg.to !== this.peerId) return;
    this.onMessage?.(msg);
  }

  _dispatchFallbackMsg(payload) {
    const msg = { ...payload, _sender: this.peerId };
    if (this.channel) {
      try {
        this.channel.postMessage(msg);
      } catch (_) {}
    }
    try {
      localStorage.setItem(this.storageKey, JSON.stringify({ ...msg, _t: Date.now() }));
    } catch (_) {}

    if (this.peerjs) {
      if (payload.to) {
        const conn = this.peerJsConns.get(payload.to) || this._connectPeerJs(payload.to);
        if (conn && conn.open) {
          try {
            conn.send(msg);
          } catch (_) {}
        }
      } else {
        // Broadcast to all active PeerJS connections across physical devices
        for (const conn of this.peerJsConns.values()) {
          if (conn && conn.open) {
            try {
              conn.send(msg);
            } catch (_) {}
          }
        }
      }
    }
  }

  readyStateLabel() {
    if (this.isFallback) return "open";
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
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {}
    }
    if (this.channel) {
      try {
        this.channel.close();
      } catch (_) {}
    }
    if (this.peerjs) {
      try {
        this.peerjs.destroy();
      } catch (_) {}
    }
    if (this.isFallback) {
      let roster = this._getRoster().filter((p) => p.peer_id !== this.peerId);
      this._saveRoster(roster);
      this._dispatchFallbackMsg({
        type: "peer_left",
        peer_id: this.peerId,
        roster,
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
