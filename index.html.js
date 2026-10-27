// ==========================================
// FlashDrop - 100% Zero Configuration Engine
// ==========================================

let peer = null;
let conn = null;
let pendingIncomingConn = null;

const CHUNK_SIZE = 64 * 1024; // 64 KB memory-safe chunking
const MAX_BUFFERED_AMOUNT = 8 * 1024 * 1024; // 8 MB backpressure threshold

// State for receiving files
let incomingFileInfo = null;
let receivedBytes = 0;
let fileStreamWriter = null;
let fallbackFileChunks = [];

// Transfer stats
let lastBytesTransferred = 0;
let lastSpeedCalcTime = 0;
let speedCalcInterval = null;
let fileToSend = null;

// UI Elements
const myNumberInput = document.getElementById("myNumber");
const receiverNumberInput = document.getElementById("receiverNumber");
const connectBtn = document.getElementById("connectBtn");
const waitingState = document.getElementById("waitingState");
const cancelOfferBtn = document.getElementById("cancelOfferBtn");
const listenerStatus = document.getElementById("listenerStatus");

const connectPanel = document.getElementById("connectPanel");
const transferPanel = document.getElementById("transferPanel");

const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");

const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");
const progressCard = document.getElementById("progressCard");
const progressBar = document.getElementById("progressBar");
const fileNameLabel = document.getElementById("fileName");
const fileMetaLabel = document.getElementById("fileMeta");
const percentText = document.getElementById("percentText");
const speedText = document.getElementById("speedText");
const etaText = document.getElementById("etaText");
const downloadContainer = document.getElementById("downloadContainer");
const downloadBtn = document.getElementById("downloadBtn");
const cancelTransferBtn = document.getElementById("cancelTransferBtn");
const disconnectBtn = document.getElementById("disconnectBtn");

const incomingModal = document.getElementById("incomingModal");
const incomingCallerText = document.getElementById("incomingCallerText");
const acceptBtn = document.getElementById("acceptBtn");
const declineBtn = document.getElementById("declineBtn");

const qrToggleBtn = document.getElementById("qrToggleBtn");
const qrModal = document.getElementById("qrModal");
const closeQrBtn = document.getElementById("closeQrBtn");
const qrcodeElem = document.getElementById("qrcode");

if (window.lucide) {
  window.lucide.createIcons();
}

// SHA-256 Hashing for Room/Peer ID
async function hashPhoneToPeerId(phone) {
  const normalized = phone.replace(/\D/g, "");
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hash));
  const hex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  return `flashdrop_${hex.substring(0, 24)}`;
}

// Format Utilities
function formatBytes(bytes) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "--:--";
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

function setUIState(state) {
  statusDot.classList.remove("bg-slate-500", "bg-amber-400", "bg-emerald-400", "connected-glow");
  if (state === "connected") {
    statusDot.classList.add("bg-emerald-400", "connected-glow");
    statusText.textContent = "Direct Connected";
    connectPanel.classList.add("hidden");
    transferPanel.classList.remove("hidden");
  } else if (state === "connecting") {
    statusDot.classList.add("bg-amber-400");
    statusText.textContent = "Connecting...";
  } else {
    statusDot.classList.add("bg-slate-500");
    statusText.textContent = "Disconnected";
    connectPanel.classList.remove("hidden");
    transferPanel.classList.add("hidden");
    waitingState.classList.add("hidden");
    resetTransferUI();
  }
}

function resetTransferUI() {
  progressCard.classList.add("hidden");
  progressBar.style.width = "0%";
  percentText.textContent = "0%";
  speedText.textContent = "0 MB/s";
  etaText.textContent = "--:--";
  downloadContainer.classList.add("hidden");
  incomingFileInfo = null;
  receivedBytes = 0;
  fallbackFileChunks = [];
  if (speedCalcInterval) clearInterval(speedCalcInterval);
}

// ----------------------------------------------------
// Step 1: Auto-Listen When User Enters Their Number
// ----------------------------------------------------
myNumberInput.addEventListener("input", async () => {
  const rawNumber = myNumberInput.value.replace(/\D/g, "");
  if (rawNumber.length >= 7) {
    initMyPeer(rawNumber);
  }
});

async function initMyPeer(phone) {
  const peerId = await hashPhoneToPeerId(phone);

  if (peer && peer.id === peerId) return;
  if (peer) peer.destroy();

  listenerStatus.textContent = "Registering listener on network...";
  listenerStatus.classList.remove("text-slate-500");
  listenerStatus.classList.add("text-brand-400");

  // Zero-config: Uses default public PeerJS cloud broker
  peer = new Peer(peerId, {
    debug: 1
  });

  peer.on("open", () => {
    listenerStatus.textContent = "Ready & listening for incoming transfers.";
    listenerStatus.classList.remove("text-brand-400");
    listenerStatus.classList.add("text-emerald-400");
  });

  peer.on("connection", (incomingConn) => {
    pendingIncomingConn = incomingConn;
    const callerNumber = incomingConn.metadata?.caller || "Remote Device";
    incomingCallerText.textContent = `Incoming connection request from: ${callerNumber}`;
    incomingModal.classList.remove("hidden");
  });

  peer.on("error", (err) => {
    if (err.type === "unavailable-id") {
      listenerStatus.textContent = "This number is already active in another tab/device.";
    } else {
      console.warn("PeerJS status:", err.type);
    }
  });
}

// Modal Handlers (Accept / Decline)
acceptBtn.addEventListener("click", () => {
  incomingModal.classList.add("hidden");
  if (!pendingIncomingConn) return;

  conn = pendingIncomingConn;
  setUIState("connecting");
  setupConnectionHandlers();
  
  // Acknowledge connection accept
  conn.on("open", () => {
    conn.send(JSON.stringify({ type: "session-accepted" }));
    setUIState("connected");
  });
});

declineBtn.addEventListener("click", () => {
  if (pendingIncomingConn) {
    pendingIncomingConn.close();
    pendingIncomingConn = null;
  }
  incomingModal.classList.add("hidden");
});

// ----------------------------------------------------
// Step 2: Caller Connects to Receiver
// ----------------------------------------------------
connectBtn.addEventListener("click", async () => {
  const myNum = myNumberInput.value.replace(/\D/g, "");
  const recNum = receiverNumberInput.value.replace(/\D/g, "");

  if (recNum.length < 7) {
    alert("Please enter a valid receiver mobile number.");
    return;
  }

  // Ensure caller has an active peer
  if (!peer || peer.destroyed) {
    const callerId = myNum ? await hashPhoneToPeerId(myNum) : undefined;
    peer = new Peer(callerId);
    await new Promise((res) => peer.on("open", res));
  }

  setUIState("connecting");
  waitingState.classList.remove("hidden");

  const targetPeerId = await hashPhoneToPeerId(recNum);
  const maskedCaller = myNum.length > 4 ? `***-***-${myNum.slice(-4)}` : "Direct Peer";

  conn = peer.connect(targetPeerId, {
    reliable: true,
    metadata: { caller: maskedCaller }
  });

  setupConnectionHandlers();
});

cancelOfferBtn.addEventListener("click", () => {
  if (conn) conn.close();
  setUIState("disconnected");
});

// ----------------------------------------------------
// Step 3: WebRTC Connection & Data Streaming
// ----------------------------------------------------
function setupConnectionHandlers() {
  conn.on("open", () => {
    setUIState("connected");
  });

  conn.on("close", () => {
    setUIState("disconnected");
    alert("Peer connection closed.");
  });

  conn.on("data", async (data) => {
    // Control Messages (JSON String)
    if (typeof data === "string") {
      try {
        const msg = JSON.parse(data);

        if (msg.type === "session-accepted") {
          setUIState("connected");
        } 
        else if (msg.type === "meta") {
          incomingFileInfo = msg;
          receivedBytes = 0;
          fallbackFileChunks = [];
          displayTransferProgress(msg.name, msg.size, 0);

          // Stream directly to local disk if supported (Multi-Gigabyte Safe)
          if ("showSaveFilePicker" in window) {
            try {
              const handle = await window.showSaveFilePicker({ suggestedName: msg.name });
              fileStreamWriter = await handle.createWritable();
            } catch (err) {
              console.warn("Direct file stream rejected. Falling back to memory accumulator.", err);
              fileStreamWriter = null;
            }
          }

          conn.send(JSON.stringify({ type: "ack" }));
          initSpeedCalculation();
        } 
        else if (msg.type === "ack") {
          startSendingFile();
        } 
        else if (msg.type === "done") {
          if (fileStreamWriter) {
            await fileStreamWriter.close();
            fileStreamWriter = null;
          } else {
            showDownloadFallbackButton();
          }
          clearInterval(speedCalcInterval);
          speedText.textContent = "Completed";
          etaText.textContent = "00:00";
          progressBar.style.width = "100%";
          percentText.textContent = "100%";
          alert("File transfer completed successfully!");
        } 
        else if (msg.type === "cancel") {
          alert("Transfer cancelled by peer.");
          resetTransferUI();
        }
      } catch (e) {
        console.error("Error processing control frame:", e);
      }
    } 
    // Binary Chunk (ArrayBuffer)
    else if (data instanceof ArrayBuffer) {
      receivedBytes += data.byteLength;

      if (fileStreamWriter) {
        // Direct stream to storage disk - Zero RAM exhaustion
        await fileStreamWriter.write(data);
      } else {
        fallbackFileChunks.push(data);
      }

      updateTransferProgress(receivedBytes, incomingFileInfo.size);
    }
  });
}

// ----------------------------------------------------
// Step 4: 10GB File Chunking & Backpressure Pipeline
// ----------------------------------------------------
dropZone.addEventListener("click", () => fileInput.click());

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("border-brand-500", "bg-brand-500/5");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("border-brand-500", "bg-brand-500/5");
});

dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("border-brand-500", "bg-brand-500/5");
  if (e.dataTransfer.files.length > 0) {
    handleFileSelected(e.dataTransfer.files[0]);
  }
});

fileInput.addEventListener("change", (e) => {
  if (e.target.files.length > 0) {
    handleFileSelected(e.target.files[0]);
  }
});

function handleFileSelected(file) {
  if (!conn || !conn.open) {
    alert("Connection not active. Please connect to receiver first.");
    return;
  }

  fileToSend = file;
  displayTransferProgress(file.name, file.size, 0);

  conn.send(JSON.stringify({
    type: "meta",
    name: file.name,
    size: file.size,
    mimeType: file.type || "application/octet-stream"
  }));
}

async function startSendingFile() {
  if (!fileToSend) return;

  const totalSize = fileToSend.size;
  let offset = 0;
  initSpeedCalculation();

  // Internal WebRTC DataChannel backpressure management
  const dc = conn.dataChannel;
  if (dc) {
    dc.bufferedAmountLowThreshold = MAX_BUFFERED_AMOUNT / 2;
  }

  while (offset < totalSize) {
    // If WebRTC queue is filled, pause chunking until bufferedamountlow triggers
    if (dc && dc.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      await new Promise((resolve) => {
        dc.onbufferedamountlow = () => {
          dc.onbufferedamountlow = null;
          resolve();
        };
      });
    }

    const chunkBlob = fileToSend.slice(offset, offset + CHUNK_SIZE);
    const chunkBuffer = await chunkBlob.arrayBuffer();

    try {
      conn.send(chunkBuffer);
    } catch (err) {
      console.error("Chunk transmission error:", err);
      alert("Transfer stopped due to connection error.");
      return;
    }

    offset += chunkBuffer.byteLength;
    updateTransferProgress(offset, totalSize);
  }

  conn.send(JSON.stringify({ type: "done" }));
  clearInterval(speedCalcInterval);
  speedText.textContent = "Completed";
  etaText.textContent = "00:00";
  alert("File sent successfully!");
}

// ----------------------------------------------------
// Step 5: Transfer Stats & Calculation
// ----------------------------------------------------
function displayTransferProgress(name, size, current) {
  progressCard.classList.remove("hidden");
  fileNameLabel.textContent = name;
  updateTransferProgress(current, size);
}

function updateTransferProgress(current, total) {
  const percent = total > 0 ? Math.min(100, (current / total) * 100) : 0;
  progressBar.style.width = `${percent.toFixed(1)}%`;
  percentText.textContent = `${percent.toFixed(1)}%`;
  fileMetaLabel.textContent = `${formatBytes(current)} / ${formatBytes(total)}`;
}

function initSpeedCalculation() {
  lastBytesTransferred = 0;
  lastSpeedCalcTime = Date.now();

  if (speedCalcInterval) clearInterval(speedCalcInterval);

  speedCalcInterval = setInterval(() => {
    const now = Date.now();
    const timeDelta = (now - lastSpeedCalcTime) / 1000;
    if (timeDelta <= 0) return;

    const currentTotal = fileToSend 
      ? (fileToSend.size * (parseFloat(percentText.textContent) / 100)) 
      : receivedBytes;

    const bytesDelta = currentTotal - lastBytesTransferred;
    const currentSpeed = bytesDelta / timeDelta;

    speedText.textContent = `${formatBytes(currentSpeed)}/s`;

    const targetSize = fileToSend ? fileToSend.size : (incomingFileInfo ? incomingFileInfo.size : 0);
    const remainingBytes = Math.max(0, targetSize - currentTotal);
    if (currentSpeed > 0) {
      etaText.textContent = formatTime(remainingBytes / currentSpeed);
    } else {
      etaText.textContent = "--:--";
    }

    lastBytesTransferred = currentTotal;
    lastSpeedCalcTime = now;
  }, 1000);
}

function showDownloadFallbackButton() {
  downloadContainer.classList.remove("hidden");
  downloadBtn.onclick = () => {
    const blob = new Blob(fallbackFileChunks, { type: incomingFileInfo.mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = incomingFileInfo.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    fallbackFileChunks = [];
  };
}

cancelTransferBtn.addEventListener("click", () => {
  if (conn && conn.open) {
    conn.send(JSON.stringify({ type: "cancel" }));
  }
  resetTransferUI();
});

disconnectBtn.addEventListener("click", () => {
  if (conn) conn.close();
  setUIState("disconnected");
});

// QR Code Pair Modal
qrToggleBtn.addEventListener("click", () => {
  qrcodeElem.innerHTML = "";
  new QRCode(qrcodeElem, {
    text: window.location.href.split("?")[0],
    width: 180,
    height: 180,
    colorDark: "#000000",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M
  });
  qrModal.classList.remove("hidden");
});

closeQrBtn.addEventListener("click", () => qrModal.classList.add("hidden"));