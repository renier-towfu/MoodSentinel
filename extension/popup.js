// MoodSentinel Extension — popup.js

const logBox = document.getElementById("logBox");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const jobInfo = document.getElementById("jobInfo");
const jobUrl = document.getElementById("jobUrl");
const apiBaseInput = document.getElementById("apiBaseInput");
const saveBtn = document.getElementById("saveBtn");

function addLog(message, type = "entry") {
  const div = document.createElement("div");
  div.className = `log-entry ${type}`;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logBox.appendChild(div);
  logBox.scrollTop = logBox.scrollHeight;
}

function setStatus(state, text, url = null) {
  statusDot.className = `dot ${state}`;
  statusText.textContent = text;
  if (url) {
    jobInfo.style.display = "block";
    jobUrl.textContent = url;
  } else {
    jobInfo.style.display = "none";
  }
}

// Load saved API base
chrome.storage.local.get(["apiBase"], (result) => {
  if (result.apiBase) apiBaseInput.value = result.apiBase;
});

// Save API base
saveBtn.addEventListener("click", () => {
  const val = apiBaseInput.value.trim().replace(/\/$/, "");
  if (!val) return;
  chrome.runtime.sendMessage({ type: "SET_API_BASE", apiBase: val }, () => {
    addLog(`Backend URL saved: ${val}`, "success");
  });
});

// Get current status from background
chrome.runtime.sendMessage({ type: "GET_STATUS" }, (response) => {
  if (!response) return;
  if (response.isProcessing) {
    setStatus("processing", "Scraping in progress...");
    addLog("A scraping job is currently running.", "info");
  } else {
    setStatus("idle", "Idle — waiting for jobs");
  }
  if (response.apiBase) apiBaseInput.value = response.apiBase;
});

// Listen for messages from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "JOB_STARTED") {
    setStatus("processing", "Scraping...", msg.url);
    addLog(`Job started: ${msg.url}`, "info");
  }
  if (msg.type === "JOB_COMPLETE") {
    setStatus("idle", "Idle — waiting for jobs");
    addLog(`Done! Scraped ${msg.commentCount} comments.`, "success");
  }
  if (msg.type === "JOB_FAILED") {
    setStatus("error", "Error — see log");
    addLog(`Job failed: ${msg.reason}`, "error");
  }
  if (msg.type === "LOG") {
    addLog(msg.message, msg.level || "entry");
  }
});
