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
    this.url = "";
  }

  connect() {
    const qs = new URLSearchParams({
      peer_id: this.peerId,
      display_name: this.displayName,
      role: this.role,
    });
    this.url = wsUrlForMeeting(this.publicId, qs);
    this.ws = new WebSocket(this.url);
    this.onState?.("connecting");
    this.ws.onmessage = (ev) => {
      try {
        this.onMessage?.(JSON.parse(ev.data));
      } catch (_) {}
    };
    this.ws.onclose = () => this.onState?.("closed");
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => {
        this.onState?.("open");
        resolve();
      };
      this.ws.onerror = () => {
        this.onState?.("error");
        reject(new Error("WebSocket connection failed"));
      };
    });
  }

  readyStateLabel() {
    if (!this.ws) return "none";
    return ["connecting", "open", "closing", "closed"][this.ws.readyState] || "unknown";
  }

  send(payload) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  close() {
    this.ws?.close();
  }
}

export async function fetchIceServers(meetingId) {
  const qs = meetingId ? `?meeting_id=${encodeURIComponent(meetingId)}` : "";
  const res = await fetch(`/api/webrtc/ice${qs}`);
  if (!res.ok) throw new Error("Failed to load ICE configuration");
  const data = await res.json();
  return data;
}
