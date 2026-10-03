/** Mesh WebRTC helpers for Minuta meeting rooms. */

function wsUrlForMeeting(publicId, qs) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws/meetings/${publicId}?${qs}`;
}

/* ───────────────────────────────────────────────────────
   MeshRoom – only used when a live WebSocket server exists.
   On static Vercel deploys PeerJS handles media directly.
   ─────────────────────────────────────────────────────── */
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
        this.signaling.send({ type: "ice_candidate", to: peerId, candidate: ev.candidate });
      }
    };
    pc.ontrack = (ev) => {
      this.onRemoteStream?.(peerId, ev.streams[0]);
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
    this._setState(peerId, { connection: pc.connectionState, ice: pc.iceConnectionState, candidateTypes: [] });
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
    if (pc) { pc.close(); this.pcs.delete(peerId); }
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
   SignalingClient – PeerJS-based signaling + media for
   static Vercel deployments (no WebSocket server).

   Architecture:
   • Each participant registers a deterministic PeerJS ID
     of the form  minuta_{meetingId}_slot{0..7}
   • A background "slot scanner" (every 3 s) tries to
     connect data + media to every other slot.
   • PeerJS .call()/.on("call") handles the ENTIRE WebRTC
     media negotiation internally (SDP + ICE).  No extra
     MeshRoom is needed in this path.
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
    this.rosterKey = `minuta_room_roster_${publicId}`;
    this.isFallback = false;
    this.peerjs = null;
    this.peerJsId = null;
    this.peerJsConns = new Map();   // slotId → DataConnection
    this.peerJsCalls = new Map();   // slotId → MediaConnection
    this.activeStreams = new Set();  // slotIds that delivered a stream
    this.slotIndex = -1;
    this.slotTimer = null;
    this._log("Created SignalingClient", { publicId, peerId, displayName });
  }

  _log(...args) {
    console.log("[Minuta-WebRTC]", ...args);
  }

  /* ─── Primary connect path ─── */
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
          this._log("WebSocket timeout – falling back to PeerJS");
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
            this._log("WebSocket connected");
            this.onState?.("open");
            resolve();
          }
        };
        this.ws.onmessage = (ev) => {
          try { this.onMessage?.(JSON.parse(ev.data)); } catch (_) {}
        };
        this.ws.onerror = () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            this._log("WebSocket error – falling back to PeerJS");
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

  /* ─── Fallback: BroadcastChannel + localStorage + PeerJS ─── */
  _initFallback() {
    this.isFallback = true;
    this.onState?.("open");

    // BroadcastChannel (same-device tabs)
    const channelName = `minuta_meeting_${this.publicId}`;
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(channelName);
      this.channel.onmessage = (ev) => this._handleFallbackMsg(ev.data);
    }

    // localStorage (same-device different tabs)
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

    // PeerJS (cross-device via 0.peerjs.com cloud relay)
    this._initPeerJS();
  }

  /* ─── PeerJS bootstrap ─── */
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
    this._log("PeerJS library loaded, trying slot registration…");
    this._trySlot(0);
  }

  _trySlot(slot) {
    const maxSlots = 8;
    if (slot >= maxSlots) {
      // All 8 slots taken – use a random ID as last resort
      const fallbackId = `minuta_${this.publicId}_extra_${Math.random().toString(36).slice(2, 8)}`;
      this._log("All slots taken, using random ID:", fallbackId);
      this._createPeer(fallbackId, slot);
      return;
    }
    const candidateId = `minuta_${this.publicId}_slot${slot}`;
    this._log(`Trying slot ${slot}: ${candidateId}`);
    this._createPeer(candidateId, slot, (err) => {
      this._log(`Slot ${slot} taken (${err?.type}), trying next…`);
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
        // Free TURN servers for NAT traversal across different networks
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
      ];

      const peer = new window.Peer(id, { config: { iceServers } });
      let registered = false;

      peer.on("open", (openId) => {
        registered = true;
        this.peerjs = peer;
        this.slotIndex = slot;
        this.peerJsId = openId;
        this._log(`✅ PeerJS registered as ${openId} (slot ${slot})`);

        // ── Handle incoming MEDIA calls ──
        peer.on("call", (call) => {
          this._log(`📞 Incoming call from ${call.peer}`);
          const streamToSend = this.localStream || new MediaStream();
          call.answer(streamToSend);
          this._bindMediaCall(call.peer, call);
        });

        // ── Handle incoming DATA connections ──
        peer.on("connection", (conn) => {
          conn.on("open", () => {
            this._log(`📡 Incoming data conn from ${conn.peer}`);
            this.peerJsConns.set(conn.peer, conn);
            // Send welcome with our info
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
          conn.on("close", () => this.peerJsConns.delete(conn.peer));
        });

        // ── Handle PeerJS errors (e.g. peer-unavailable for non-existent slots) ──
        peer.on("error", (err) => {
          if (err?.type === "peer-unavailable") {
            // Extract the failed peer ID from the error message
            const match = err.message?.match(/peer\s+(\S+)/i);
            if (match) {
              const failedId = match[1];
              this.peerJsCalls.delete(failedId);
              this.activeStreams.delete(failedId);
            }
          }
          // All other post-registration errors: log but don't crash
          this._log("PeerJS error:", err?.type, err?.message);
        });

        // ── Start the slot scanner ──
        this._startSlotScanner();
      });

      peer.on("error", (err) => {
        if (!registered) {
          // Registration failed (slot taken) – try next slot
          try { peer.destroy(); } catch (_) {}
          onRegistrationError?.(err);
        }
      });
    } catch (e) {
      onRegistrationError?.(e);
    }
  }

  /* ─── Bind a MediaConnection and track its lifecycle ─── */
  _bindMediaCall(remoteId, call) {
    this.peerJsCalls.set(remoteId, call);

    call.on("stream", (remoteStream) => {
      this._log(`🎥 Got video stream from ${remoteId}, tracks:`, remoteStream.getTracks().map(t => t.kind));
      this.activeStreams.add(remoteId);
      this.onRemoteStream?.(remoteId, remoteStream);
    });

    call.on("close", () => {
      this._log(`❌ Media call closed: ${remoteId}`);
      this.peerJsCalls.delete(remoteId);
      this.activeStreams.delete(remoteId);
    });

    call.on("error", (err) => {
      this._log(`❌ Media call error: ${remoteId}`, err);
      this.peerJsCalls.delete(remoteId);
      this.activeStreams.delete(remoteId);
    });

    // Safety timeout: if no stream received in 8 seconds, clean up so
    // the slot scanner can retry on the next cycle.
    setTimeout(() => {
      if (!this.activeStreams.has(remoteId)) {
        this._log(`⏰ Timeout waiting for stream from ${remoteId}, will retry`);
        this.peerJsCalls.delete(remoteId);
        try { call.close(); } catch (_) {}
      }
    }, 8000);
  }

  /* ─── Slot scanner: discover & connect to other participants ─── */
  _startSlotScanner() {
    if (this.slotTimer) clearInterval(this.slotTimer);

    const scan = () => {
      if (!this.peerjs || this.peerjs.destroyed) return;

      for (let s = 0; s < 8; s++) {
        if (s === this.slotIndex) continue;
        const targetId = `minuta_${this.publicId}_slot${s}`;

        // Skip if we already have an active media stream from this peer
        if (this.activeStreams.has(targetId)) continue;

        // Try DATA connection (for chat, roster, etc.)
        const existingConn = this.peerJsConns.get(targetId);
        if (!existingConn || !existingConn.open) {
          this._connectDataChannel(targetId);
        }

        // Try MEDIA call (camera/microphone exchange)
        if (!this.peerJsCalls.has(targetId)) {
          this._callSlot(targetId);
        }
      }
    };

    // First scan immediately, then every 3 seconds
    scan();
    this.slotTimer = setInterval(scan, 3000);
  }

  _callSlot(targetId) {
    if (!this.peerjs || this.peerjs.destroyed) return;
    const streamToSend = this.localStream || new MediaStream();
    try {
      this._log(`📞 Calling ${targetId}…`);
      const call = this.peerjs.call(targetId, streamToSend);
      if (call) {
        this._bindMediaCall(targetId, call);
      }
    } catch (err) {
      this._log(`Call to ${targetId} failed:`, err);
    }
  }

  _connectDataChannel(targetId) {
    if (!this.peerjs || this.peerjs.destroyed) return;
    try {
      const conn = this.peerjs.connect(targetId);
      conn._pending = [{
        type: "peer_joined",
        peer_id: this.peerJsId,
        display_name: this.displayName,
        role: this.role,
        roster: this._buildRoster(),
        _sender: this.peerJsId,
      }];

      conn.on("open", () => {
        this._log(`📡 Data channel open to ${targetId}`);
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

      // Timeout: if data connection doesn't open in 6s, clean up for retry
      setTimeout(() => {
        if (!conn.open) {
          this.peerJsConns.delete(targetId);
          try { conn.close(); } catch (_) {}
        }
      }, 6000);
    } catch (_) {}
  }

  /* ─── Roster helpers ─── */
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

  /* ─── Fallback message handling ─── */
  _handleFallbackMsg(msg) {
    if (!msg) return;
    const sender = msg._sender || msg.from || msg.peer_id;
    if (sender === this.peerId || sender === this.peerJsId) return;
    if (msg.to && msg.to !== this.peerId && msg.to !== this.peerJsId) return;

    // Enrich roster for join/welcome messages
    if (msg.type === "peer_joined" || msg.type === "welcome") {
      msg.roster = this._buildRoster();
    }
    this.onMessage?.(msg);
  }

  _dispatchFallbackMsg(payload) {
    const msg = { ...payload, _sender: this.peerJsId || this.peerId };

    // BroadcastChannel (same-device tabs)
    if (this.channel) {
      try { this.channel.postMessage(msg); } catch (_) {}
    }

    // localStorage (same-device different tabs)
    try {
      localStorage.setItem(this.storageKey, JSON.stringify({ ...msg, _t: Date.now() }));
    } catch (_) {}

    // PeerJS data connections (cross-device)
    for (const conn of this.peerJsConns.values()) {
      if (conn && conn.open) {
        try { conn.send(msg); } catch (_) {}
      } else if (conn) {
        if (!conn._pending) conn._pending = [];
        conn._pending.push(msg);
      }
    }
  }

  /* ─── Public API ─── */
  readyStateLabel() {
    if (this.isFallback) {
      const slot = this.slotIndex >= 0 ? `slot ${this.slotIndex}` : "connecting";
      const streams = this.activeStreams.size;
      return `PeerJS (${slot}, ${streams} stream${streams !== 1 ? "s" : ""})`;
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
    this._log("Closing SignalingClient");
    if (this.slotTimer) { clearInterval(this.slotTimer); this.slotTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch (_) {} }
    if (this.channel) { try { this.channel.close(); } catch (_) {} }

    // Notify peers we're leaving
    if (this.isFallback) {
      this._dispatchFallbackMsg({
        type: "peer_left",
        peer_id: this.peerJsId || this.peerId,
        display_name: this.displayName,
      });
    }

    // Close all media calls
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
