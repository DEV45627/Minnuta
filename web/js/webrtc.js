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

    console.log(`[MINUTA RTC] Creating RTCPeerConnection: ${peerId}`);
    logMinuta("Creating RTCPeerConnection", `for peer ${peerId}`);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this.localStream);
        if (track.kind === "video") console.log(`[MINUTA RTC] Added local video track to ${peerId}`);
        if (track.kind === "audio") console.log(`[MINUTA RTC] Added local audio track to ${peerId}`);
      });
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        console.log(`[MINUTA RTC] ICE candidate sent: ${ev.candidate.candidate.slice(0, 40)}...`);
        logMinuta("Sending ICE candidate", `to ${peerId}`);
        this.signaling.send({
          type: "ice_candidate",
          to: peerId,
          candidate: ev.candidate,
        });
      }
    };

    pc.ontrack = (ev) => {
      if (ev.track.kind === "video") console.log(`[MINUTA RTC] REMOTE VIDEO TRACK RECEIVED FROM ${peerId}`);
      if (ev.track.kind === "audio") console.log(`[MINUTA RTC] REMOTE AUDIO TRACK RECEIVED FROM ${peerId}`);
      logMinuta("Remote track received", `kind=${ev.track.kind} from ${peerId}`);
      const remoteStream = ev.streams[0] || new MediaStream([ev.track]);
      this.onRemoteStream?.(peerId, remoteStream);
    };

    pc.onconnectionstatechange = () => {
      console.log(`[MINUTA RTC] Peer connection state ${peerId}: ${pc.connectionState}`);
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
      console.log(`[MINUTA RTC] ICE connection state ${peerId}: ${pc.iceConnectionState}`);
      logMinuta("ICE connection state", `${peerId}: ${pc.iceConnectionState}`);
      this._setState(peerId, { ice: pc.iceConnectionState });
    };

    // Stats monitor
    const statsInterval = setInterval(async () => {
      if (pc.connectionState === "closed" || !this.pcs.has(peerId)) {
        clearInterval(statsInterval);
        return;
      }
      try {
        const stats = await pc.getStats();
        let inVideo = 0, inAudio = 0;
        stats.forEach((report) => {
          if (report.type === "inbound-rtp") {
            if (report.kind === "video") inVideo = report.bytesReceived || 0;
            if (report.kind === "audio") inAudio = report.bytesReceived || 0;
          }
        });
        if (inVideo > 0 || inAudio > 0) {
          console.log(`[MINUTA RTC] RTCStats for ${peerId}: inbound video bytes: ${inVideo}, audio bytes: ${inAudio}`);
        }
      } catch (_) {}
    }, 5000);

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
      console.log(`[MINUTA RTC] Offer sent: SDP offer created for ${peerId}`);
      await pc.setLocalDescription(offer);
      this.signaling.send({
        type: "offer",
        to: peerId,
        sdp: pc.localDescription,
      });
    } catch (err) {
      console.error("[MINUTA RTC] Offer error:", err);
    } finally {
      this.makingOffer.delete(peerId);
    }
  }

  async handleOffer(from, sdp) {
    try {
      console.log(`[MINUTA RTC] Offer received: from ${from}`);
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
      console.log(`[MINUTA RTC] Remote description set for offer from ${from}`);
      logMinuta("Creating answer", `for ${from}`);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      console.log(`[MINUTA RTC] Answer sent: to ${from}`);
      this.signaling.send({
        type: "answer",
        to: from,
        sdp: pc.localDescription,
      });
    } catch (err) {
      console.error("[MINUTA RTC] Handle offer error:", err);
    }
  }

  async handleAnswer(from, sdp) {
    try {
      console.log(`[MINUTA RTC] Answer received: from ${from}`);
      logMinuta("Received answer", `from ${from}`);
      const pc = this.pcs.get(from);
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      console.log(`[MINUTA RTC] Remote description set for answer from ${from}`);
    } catch (err) {
      console.error("[MINUTA RTC] Handle answer error:", err);
    }
  }

  async handleIce(from, candidate) {
    try {
      console.log(`[MINUTA RTC] ICE candidate received: from ${from}`);
      logMinuta("Received ICE candidate", `from ${from}`);
      const pc = await this.ensurePc(from);
      if (candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    } catch (err) {
      console.error("[MINUTA RTC] Handle ICE error:", err);
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
   SignalingClient – Authoritative FastAPI WebSocket Signaling
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
    this.roster = [];
    this.reconnectTimer = null;
    this.closedExplicitly = false;

    console.log(`[MINUTA RTC] MEETING ID: ${publicId}`);
    console.log(`[MINUTA RTC] MY PARTICIPANT ID: ${peerId}`);
    logMinuta("Joining room", `Room: ${publicId} | Peer: ${peerId} | User: ${displayName}`);
  }

  connect() {
    this.closedExplicitly = false;
    this.onState?.("connecting");
    const params = {
      peer_id: this.peerId,
      display_name: this.displayName,
      role: this.role,
    };
    const url = getSignalingWsUrl(this.publicId, params);

    return new Promise((resolve) => {
      let resolved = false;

      try {
        logMinuta("Connecting to signaling server", url);
        console.log(`[MINUTA RTC] Connecting to WebSocket: ${url}`);
        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
          if (!resolved) {
            resolved = true;
            console.log("[MINUTA RTC] WebSocket connected to FastAPI signaling server");
            console.log(`[MINUTA RTC] MEETING ID: ${this.publicId}`);
            console.log(`[MINUTA RTC] MY PARTICIPANT ID: ${this.peerId}`);
            logMinuta("Connected to signaling server", "FastAPI WebSocket connection active");
            this.onState?.("open");
            resolve();
          }
        };

        this.ws.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data);
            if (data.type === "welcome") {
              this.roster = data.roster || [];
              console.log("[MINUTA RTC] Server welcome received. Roster size:", this.roster.length);
            } else if (data.type === "peer_joined") {
              this.roster = data.roster || this.roster;
              console.log(`[MINUTA RTC] REAL PEER JOINED: ${data.peer_id} (${data.display_name})`);
            } else if (data.type === "peer_left") {
              this.roster = data.roster || this.roster.filter((p) => p.peer_id !== data.peer_id);
              console.log(`[MINUTA RTC] REAL PEER LEFT: ${data.peer_id}`);
            }
            this.onMessage?.(data);
          } catch (err) {
            console.error("[MINUTA RTC] Message parsing error:", err);
          }
        };

        this.ws.onerror = (err) => {
          console.error("[MINUTA RTC] WebSocket error:", err);
          if (!resolved) {
            resolved = true;
            this.onState?.("error");
            resolve();
          }
        };

        this.ws.onclose = () => {
          console.log("[MINUTA RTC] WebSocket closed");
          this.onState?.("closed");
          if (!this.closedExplicitly) {
            console.log("[MINUTA RTC] Reconnecting in 3s...");
            this.reconnectTimer = setTimeout(() => this.connect(), 3000);
          }
        };
      } catch (err) {
        console.error("[MINUTA RTC] WebSocket init exception:", err);
        if (!resolved) {
          resolved = true;
          this.onState?.("error");
          resolve();
        }
      }
    });
  }

  send(payload) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    } else {
      console.warn("[MINUTA RTC] Cannot send payload, WebSocket not open:", payload.type);
    }
  }

  readyStateLabel() {
    if (!this.ws) return "none";
    return ["connecting", "open", "closing", "closed"][this.ws.readyState] || "unknown";
  }

  close() {
    this.closedExplicitly = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
    }
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
