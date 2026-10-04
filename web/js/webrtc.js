/**
 * Minuta WebRTC & Real-time Communication Module
 * Fully supports multi-device video/audio calls across different networks.
 */

import { getSignalingWsUrl, getApiBaseUrl } from "./config.js";

export function logMinuta(event, details = "") {
  console.log(`[MINUTA] ${event}`, details ? details : "");
}

/* ───────────────────────────────────────────────────────
   MeshRoom – RTCPeerConnection mesh manager for WebSocket signaling
   ─────────────────────────────────────────────────────── */
export class MeshRoom {
  constructor({ signaling, localStream, iceServers, onRemoteStream, onPeerLeft, onPeerState, peerId }) {
    this.signaling = signaling;
    this.localStream = localStream;
    this.iceServers = iceServers || [{ urls: "stun:stun.l.google.com:19302" }];
    this.onRemoteStream = onRemoteStream;
    this.onPeerLeft = onPeerLeft;
    this.onPeerState = onPeerState;
    this.myPeerId = peerId;
    this.pcs = new Map();
    this.peerStates = new Map();
    this.makingOffer = new Set();
    this.ignoreOffer = new Set();
  }

  _setState(peerId, patch) {
    const prev = this.peerStates.get(peerId) || {};
    const next = { ...prev, ...patch };
    this.peerStates.set(peerId, next);
    this.onPeerState?.(peerId, next);
  }

  async ensurePc(peerId) {
    if (this.pcs.has(peerId)) return this.pcs.get(peerId);

    logMinuta("Creating RTCPeerConnection", `for peer ${peerId}`);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this.localStream);
      });
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        logMinuta("Sending ICE candidate", `to ${peerId}: ${ev.candidate.candidate.slice(0, 40)}...`);
        this.signaling.send({
          type: "ice_candidate",
          to: peerId,
          candidate: ev.candidate,
        });
      }
    };

    pc.ontrack = (ev) => {
      logMinuta("Remote track received", `kind=${ev.track.kind} from ${peerId}`);
      const remoteStream = ev.streams[0] || new MediaStream([ev.track]);
      this.onRemoteStream?.(peerId, remoteStream);
    };

    pc.onconnectionstatechange = () => {
      logMinuta("Peer connection state", `${peerId}: ${pc.connectionState}`);
      this._setState(peerId, { connection: pc.connectionState });
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
        setTimeout(() => {
          if (["failed", "closed"].includes(pc.connectionState)) {
            this.closePeer(peerId);
          }
        }, 3000);
      }
    };

    pc.oniceconnectionstatechange = () => {
      logMinuta("ICE connection state", `${peerId}: ${pc.iceConnectionState}`);
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
    try {
      logMinuta("Creating offer", `for ${peerId}`);
      const pc = await this.ensurePc(peerId);
      this.makingOffer.add(peerId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signaling.send({
        type: "offer",
        to: peerId,
        sdp: pc.localDescription,
      });
    } catch (err) {
      console.error("[MINUTA] Offer error:", err);
    } finally {
      this.makingOffer.delete(peerId);
    }
  }

  async handleOffer(from, sdp) {
    try {
      logMinuta("Received offer", `from ${from}`);
      const pc = await this.ensurePc(from);

      const isPolite = (this.myPeerId || "").localeCompare(from) > 0;
      const offerCollision = this.makingOffer.has(from) || pc.signalingState !== "stable";
      this.ignoreOffer.delete(from);

      if (offerCollision && !isPolite) {
        logMinuta("Ignoring offer due to collision (impolite peer)", from);
        this.ignoreOffer.add(from);
        return;
      }

      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      logMinuta("Creating answer", `for ${from}`);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signaling.send({
        type: "answer",
        to: from,
        sdp: pc.localDescription,
      });
    } catch (err) {
      console.error("[MINUTA] Handle offer error:", err);
    }
  }

  async handleAnswer(from, sdp) {
    try {
      logMinuta("Received answer", `from ${from}`);
      const pc = this.pcs.get(from);
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    } catch (err) {
      console.error("[MINUTA] Handle answer error:", err);
    }
  }

  async handleIce(from, candidate) {
    try {
      logMinuta("Received ICE candidate", `from ${from}`);
      const pc = await this.ensurePc(from);
      if (candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    } catch (err) {
      console.error("[MINUTA] Handle ICE error:", err);
    }
  }

  replaceVideoTrack(track) {
    for (const pc of this.pcs.values()) {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender) sender.replaceTrack(track);
    }
  }

  closePeer(peerId) {
    logMinuta("Participant left", `Closing peer connection ${peerId}`);
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
    return [...this.peerStates.entries()].map(([peerId, state]) => ({ peerId, ...state }));
  }
}

/* ───────────────────────────────────────────────────────
   SignalingClient – WebSockets Primary + PeerJS Cloud Fallback
   ─────────────────────────────────────────────────────── */
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
    this.isFallback = false;
    this.peerjs = null;
    this.peerJsId = null;
    this.peerJsConns = new Map();
    this.peerJsCalls = new Map();
    this.activeStreams = new Set();
    this.slotIndex = -1;
    this.slotTimer = null;

    logMinuta("Joining room", `Room: ${publicId} | Peer: ${peerId} | User: ${displayName}`);
  }

  connect() {
    this.onState?.("connecting");
    const params = {
      peer_id: this.peerId,
      display_name: this.displayName,
      role: this.role,
    };
    const url = getSignalingWsUrl(this.publicId, params);

    return new Promise((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          logMinuta("WebSocket connection timeout", "Falling back to PeerJS cloud relay");
          this._initFallback();
          resolve();
        }
      }, 1500);

      try {
        logMinuta("Connecting to signaling server", url);
        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            logMinuta("Connected to signaling server", "WebSocket connection active");
            this.onState?.("open");
            resolve();
          }
        };

        this.ws.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data);
            if (data.type === "peer_joined") {
              logMinuta("Participant joined", `${data.display_name || data.peer_id}`);
            } else if (data.type === "peer_left") {
              logMinuta("Participant left", `${data.peer_id}`);
            }
            this.onMessage?.(data);
          } catch (_) {}
        };

        this.ws.onerror = (err) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            logMinuta("WebSocket signaling error", "Falling back to PeerJS cloud relay");
            this._initFallback();
            resolve();
          }
        };

        this.ws.onclose = () => {
          if (this.isFallback) return;
          logMinuta("Signaling connection closed");
          this.onState?.("closed");
        };
      } catch (err) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          logMinuta("WebSocket initialization error", err.message);
          this._initFallback();
          resolve();
        }
      }
    });
  }

  _initFallback() {
    this.isFallback = true;
    this.onState?.("open");
    logMinuta("Connected to signaling server", "PeerJS Cloud Fallback Mode");

    // Local tab broadcast
    const channelName = `minuta_meeting_${this.publicId}`;
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(channelName);
      this.channel.onmessage = (ev) => this._handleFallbackMsg(ev.data);
    }

    // Cross-tab storage listener
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
    const script = document.createElement("script");
    script.src = "https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js";
    script.onload = () => this._setupPeerJS();
    script.onerror = () => {
      const backup = document.createElement("script");
      backup.src = "https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js";
      backup.onload = () => this._setupPeerJS();
      document.head.appendChild(backup);
    };
    document.head.appendChild(script);
  }

  _setupPeerJS() {
    if (!window.Peer || this.peerjs) return;
    this._trySlot(0);
  }

  _trySlot(slot) {
    const maxSlots = 8;
    if (slot >= maxSlots) {
      const fallbackId = `minuta_${this.publicId}_extra_${Math.random().toString(36).slice(2, 8)}`;
      this._createPeer(fallbackId, slot);
      return;
    }
    const candidateId = `minuta_${this.publicId}_slot${slot}`;
    this._createPeer(candidateId, slot, () => {
      this._trySlot(slot + 1);
    });
  }

  _createPeer(id, slot, onRegistrationError) {
    try {
      const iceServers = [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
        { urls: "stun:stun3.l.google.com:19302" },
        { urls: "stun:global.stun.twilio.com:3478" },
        {
          urls: "turn:a.relay.metered.ca:80",
          username: "e8dd65b092860a7b0ac2f090",
          credential: "5ujhNPGlR4+L1RaK",
        },
        {
          urls: "turn:a.relay.metered.ca:443",
          username: "e8dd65b092860a7b0ac2f090",
          credential: "5ujhNPGlR4+L1RaK",
        },
        {
          urls: "turn:a.relay.metered.ca:443?transport=tcp",
          username: "e8dd65b092860a7b0ac2f090",
          credential: "5ujhNPGlR4+L1RaK",
        },
        {
          urls: "turn:openrelay.metered.ca:80",
          username: "openrelayproject",
          credential: "openrelayproject",
        },
        {
          urls: "turn:openrelay.metered.ca:443",
          username: "openrelayproject",
          credential: "openrelayproject",
        },
        {
          urls: "turn:openrelay.metered.ca:443?transport=tcp",
          username: "openrelayproject",
          credential: "openrelayproject",
        },
      ];

      const peer = new window.Peer(id, { config: { iceServers } });
      let registered = false;

      peer.on("open", (openId) => {
        registered = true;
        this.peerjs = peer;
        this.slotIndex = slot;
        this.peerJsId = openId;
        logMinuta("PeerJS registered", `Slot ${slot}: ${openId}`);

        peer.on("call", (call) => {
          logMinuta("Received incoming media call", `from ${call.peer}`);
          const streamToSend = this.localStream || new MediaStream();
          call.answer(streamToSend);
          this._bindMediaCall(call.peer, call);
        });

        peer.on("connection", (conn) => {
          conn.on("open", () => {
            logMinuta("Participant joined", `PeerJS data connection from ${conn.peer}`);
            this.peerJsConns.set(conn.peer, conn);
            try {
              conn.send({
                type: "welcome",
                roster: this._buildRoster(),
                _sender: this.peerJsId,
              });
            } catch (_) {}
          });
          conn.on("data", (data) => {
            if (data && data._sender) this.peerJsConns.set(data._sender, conn);
            if (data && data.display_name) conn._displayName = data.display_name;
            this._handleFallbackMsg(data);
          });
          conn.on("close", () => {
            logMinuta("Participant left", `PeerJS data channel closed: ${conn.peer}`);
            this.peerJsConns.delete(conn.peer);
          });
        });

        peer.on("error", (err) => {
          if (err?.type === "peer-unavailable") {
            const match = err.message?.match(/peer\s+(\S+)/i);
            if (match) {
              const failedId = match[1];
              this.peerJsCalls.delete(failedId);
              this.activeStreams.delete(failedId);
            }
          }
        });

        this._startSlotScanner();
      });

      peer.on("error", (err) => {
        if (!registered) {
          try { peer.destroy(); } catch (_) {}
          onRegistrationError?.(err);
        }
      });
    } catch (e) {
      onRegistrationError?.(e);
    }
  }

  _bindMediaCall(remoteId, call) {
    this.peerJsCalls.set(remoteId, call);

    call.on("stream", (remoteStream) => {
      logMinuta("Remote track received", `via PeerJS from ${remoteId} (tracks: ${remoteStream.getTracks().length})`);
      this.activeStreams.add(remoteId);
      this.onRemoteStream?.(remoteId, remoteStream);
    });

    call.on("close", () => {
      logMinuta("Participant left", `PeerJS media call closed: ${remoteId}`);
      this.peerJsCalls.delete(remoteId);
      this.activeStreams.delete(remoteId);
    });

    call.on("error", (err) => {
      logMinuta("Peer connection state", `PeerJS call error ${remoteId}: ${err?.message}`);
      this.peerJsCalls.delete(remoteId);
      this.activeStreams.delete(remoteId);
    });
  }

  replaceVideoTrack(track) {
    for (const call of this.peerJsCalls.values()) {
      if (call && call.peerConnection) {
        const sender = call.peerConnection.getSenders().find((s) => s.track && s.track.kind === "video");
        if (sender) sender.replaceTrack(track);
      }
    }
  }

  _startSlotScanner() {
    if (this.slotTimer) clearInterval(this.slotTimer);

    const scan = () => {
      if (!this.peerjs || this.peerjs.destroyed || this.slotIndex < 0) return;

      for (let s = 0; s < 8; s++) {
        // Lower slot index initiates call to higher slot index to prevent glare / double calls
        if (s <= this.slotIndex) continue;
        const targetId = `minuta_${this.publicId}_slot${s}`;
        if (this.activeStreams.has(targetId)) continue;

        const existingConn = this.peerJsConns.get(targetId);
        if (!existingConn || !existingConn.open) {
          this._connectDataChannel(targetId);
        }

        if (!this.peerJsCalls.has(targetId)) {
          this._callSlot(targetId);
        }
      }
    };

    scan();
    this.slotTimer = setInterval(scan, 4000);
  }

  _callSlot(targetId) {
    if (!this.peerjs || this.peerjs.destroyed) return;
    const streamToSend = this.localStream || new MediaStream();
    try {
      logMinuta("Creating offer", `Calling PeerJS target ${targetId}`);
      const call = this.peerjs.call(targetId, streamToSend);
      if (call) {
        this._bindMediaCall(targetId, call);
      }
    } catch (err) {}
  }

  _connectDataChannel(targetId) {
    if (!this.peerjs || this.peerjs.destroyed) return;
    try {
      const conn = this.peerjs.connect(targetId);
      conn._pending = [
        {
          type: "peer_joined",
          peer_id: this.peerJsId,
          display_name: this.displayName,
          role: this.role,
          roster: this._buildRoster(),
          _sender: this.peerJsId,
        },
      ];

      conn.on("open", () => {
        this.peerJsConns.set(targetId, conn);
        if (conn._pending) {
          for (const m of conn._pending) {
            try { conn.send(m); } catch (_) {}
          }
          conn._pending = [];
        }
      });
      conn.on("data", (data) => {
        if (data && data.display_name) conn._displayName = data.display_name;
        if (data && data._sender) this.peerJsConns.set(data._sender, conn);
        this._handleFallbackMsg(data);
      });
      conn.on("close", () => this.peerJsConns.delete(targetId));
      conn.on("error", () => this.peerJsConns.delete(targetId));

      setTimeout(() => {
        if (!conn.open) {
          this.peerJsConns.delete(targetId);
          try { conn.close(); } catch (_) {}
        }
      }, 6000);
    } catch (_) {}
  }

  _buildRoster() {
    const list = [];
    for (const [id, conn] of this.peerJsConns.entries()) {
      if (conn.open) {
        list.push({ peer_id: id, display_name: conn._displayName || "Participant", role: "participant" });
      }
    }
    list.push({ peer_id: this.peerJsId || this.peerId, display_name: this.displayName, role: this.role });
    return list;
  }

  _handleFallbackMsg(msg) {
    if (!msg) return;
    const sender = msg._sender || msg.from || msg.peer_id;
    if (sender === this.peerId || sender === this.peerJsId) return;
    if (msg.to && msg.to !== this.peerId && msg.to !== this.peerJsId) return;

    if (msg.type === "peer_joined" || msg.type === "welcome") {
      msg.roster = this._buildRoster();
    }
    this.onMessage?.(msg);
  }

  _dispatchFallbackMsg(payload) {
    const msg = { ...payload, _sender: this.peerJsId || this.peerId };

    if (this.channel) {
      try { this.channel.postMessage(msg); } catch (_) {}
    }

    try {
      localStorage.setItem(this.storageKey, JSON.stringify({ ...msg, _t: Date.now() }));
    } catch (_) {}

    for (const conn of this.peerJsConns.values()) {
      if (conn && conn.open) {
        try { conn.send(msg); } catch (_) {}
      }
    }
  }

  readyStateLabel() {
    if (this.isFallback) {
      const slot = this.slotIndex >= 0 ? `slot ${this.slotIndex}` : "connecting";
      const streams = this.activeStreams.size;
      return `PeerJS Cloud (${slot}, ${streams} active stream${streams !== 1 ? "s" : ""})`;
    }
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
    logMinuta("Participant left", "Closing SignalingClient");
    if (this.slotTimer) { clearInterval(this.slotTimer); this.slotTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch (_) {} }
    if (this.channel) { try { this.channel.close(); } catch (_) {} }

    if (this.isFallback) {
      this._dispatchFallbackMsg({
        type: "peer_left",
        peer_id: this.peerJsId || this.peerId,
        display_name: this.displayName,
      });
    }

    for (const call of this.peerJsCalls.values()) {
      try { call.close(); } catch (_) {}
    }
    this.peerJsCalls.clear();
    this.activeStreams.clear();

    if (this.peerjs) { try { this.peerjs.destroy(); } catch (_) {} }
  }
}

export async function fetchIceServers(meetingId) {
  try {
    const apiBase = getApiBaseUrl();
    const qs = meetingId ? `?meeting_id=${encodeURIComponent(meetingId)}` : "";
    const res = await fetch(`${apiBase}/api/webrtc/ice${qs}`);
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
      {
        urls: "turn:a.relay.metered.ca:80",
        username: "e8dd65b092860a7b0ac2f090",
        credential: "5ujhNPGlR4+L1RaK",
      },
      {
        urls: "turn:a.relay.metered.ca:443",
        username: "e8dd65b092860a7b0ac2f090",
        credential: "5ujhNPGlR4+L1RaK",
      },
    ],
    has_stun: true,
    has_turn: true,
  };
}
