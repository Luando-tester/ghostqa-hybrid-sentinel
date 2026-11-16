import React, { useState, useEffect } from "react";
import { checkOnDeviceSupport, isFirebaseConfigured } from "./firebase/hybridClient";
import {
  extractCandidateNodesFromDocument,
  SAMPLE_CANDIDATES,
} from "./scanner/domExtractor";
import { triageElementOnDevice, generateCloudPatch } from "./scanner/hybridAuditor";

// Ước tính chi phí tiết kiệm được cho mỗi element triage on-device thay vì gọi Cloud LLM (~$0.0004/call)
const ESTIMATED_CLOUD_COST_PER_CHECK_USD = 0.0004;

export default function App() {
  const [url, setUrl] = useState("http://localhost:3000");
  const [deviceInfo, setDeviceInfo] = useState({
    supported: false,
    status: "checking",
    reason: "Đang kiểm tra Chrome Gemini Nano...",
  });
  const [scanning, setScanning] = useState(false);
  const [bugs, setBugs] = useState([]);
  const [onDeviceCount, setOnDeviceCount] = useState(0);
  const [generatingFix, setGeneratingFix] = useState(false);
  const [patchResult, setPatchResult] = useState(null);

  useEffect(() => {
    checkOnDeviceSupport().then(setDeviceInfo);

    // Nếu chạy dưới dạng Chrome Extension, tự động lấy URL của tab hiện tại
    if (typeof chrome !== "undefined" && chrome.tabs?.query) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs?.[0]?.url) setUrl(tabs[0].url);
      });
    }
  }, []);

  async function handleStartScan() {
    setScanning(true);
    setBugs([]);
    setPatchResult(null);

    let candidates = [];

    // Nhánh 1: Chạy trong Chrome Extension -> tiêm script vào tab đang mở để quét DOM thật
    if (typeof chrome !== "undefined" && chrome.tabs?.query && chrome.scripting?.executeScript) {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id && !tab.url?.startsWith("chrome://")) {
          const injectionResults = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: extractCandidateNodesFromDocument,
          });
          candidates = injectionResults?.[0]?.result || [];
        }
      } catch (err) {
        console.warn("Extension DOM injection fallback:", err);
      }
    }

    // Nhánh 2: Chạy ở Web Dashboard hoặc tab chrome:// -> quét DOM hiện tại + sample candidates
    if (candidates.length === 0) {
      const localDom = extractCandidateNodesFromDocument();
      candidates = localDom.length > 0 ? localDom : SAMPLE_CANDIDATES;
    }

    const detected = [];
    let localExecutions = 0;

    for (const item of candidates) {
      const verdict = await triageElementOnDevice(item.htmlSnippet, item.issueType);
      if (verdict.inferenceSource === "on-device") {
        localExecutions += 1;
        setOnDeviceCount((prev) => prev + 1);
      }
      if (verdict.isBug) {
        detected.push({ ...item, ...verdict });
        setBugs([...detected]);
      }
    }

    setScanning(false);
  }

  async function handleGenerateDeepFix() {
    if (bugs.length === 0) return;
    setGeneratingFix(true);
    try {
      const res = await generateCloudPatch(url, bugs);
      setPatchResult(res);
    } finally {
      setGeneratingFix(false);
    }
  }

  const savedUsd = (onDeviceCount * ESTIMATED_CLOUD_COST_PER_CHECK_USD).toFixed(4);

  return (
    <div style={{ maxWidth: 760, minWidth: 420, margin: "0 auto", padding: 16 }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, color: "#f8fafc" }}>
            GhostQA Local-First Sentinel
          </h2>
          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>
            {deviceInfo.reason}
          </div>
        </div>
        <div
          style={{
            background: "#1e293b",
            border: "1px solid #334155",
            borderRadius: 8,
            padding: "6px 10px",
            textAlign: "right",
          }}
        >
          <div style={{ fontSize: 11, color: "#94a3b8" }}>Cloud Cost Saved</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#34d399" }}>
            ${savedUsd} ({onDeviceCount} local checks)
          </div>
        </div>
      </div>

      {!isFirebaseConfigured && (
        <div
          style={{
            background: "#451a03",
            border: "1px solid #d97706",
            color: "#fde68a",
            padding: "8px 12px",
            borderRadius: 6,
            fontSize: 12,
            marginBottom: 12,
          }}
        >
          Chưa điền Firebase Config thật trong <code>.env</code> — đang chạy chế độ Demo Fallback.
        </div>
      )}

      {/* URL Input & Scan Trigger */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com hoặc http://localhost:3000"
          style={{
            flex: 1,
            padding: "8px 12px",
            borderRadius: 6,
            border: "1px solid #334155",
            background: "#1e293b",
            color: "#f8fafc",
            fontSize: 13,
          }}
        />
        <button
          onClick={handleStartScan}
          disabled={scanning}
          style={{
            padding: "8px 16px",
            borderRadius: 6,
            border: "none",
            background: scanning ? "#475569" : "#10b981",
            color: "#062016",
            fontWeight: 700,
            cursor: scanning ? "not-allowed" : "pointer",
            fontSize: 13,
          }}
        >
          {scanning ? "Scanning DOM..." : "Start Scan"}
        </button>
      </div>

      {/* Bug List */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {bugs.map((bug) => {
          const isLocal = bug.inferenceSource === "on-device";
          return (
            <div
              key={bug.id}
              style={{
                background: "#111827",
                border: "1px solid #1f2937",
                borderRadius: 8,
                padding: 12,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {/* Badge ON-DEVICE (xanh lá) / CLOUD (xanh dương) */}
                  <span
                    style={{
                      padding: "2px 8px",
                      borderRadius: 999,
                      fontSize: 11,
                      fontWeight: 700,
                      background: isLocal ? "#064e3b" : "#1e3a8a",
                      color: isLocal ? "#34d399" : "#93c5fd",
                      border: `1px solid ${isLocal ? "#10b981" : "#3b82f6"}`,
                    }}
                  >
                    {isLocal ? "ON-DEVICE" : "CLOUD"} • {bug.latencyMs}ms
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#f59e0b" }}>
                    [{bug.severity.toUpperCase()}] {bug.issueType}
                  </span>
                </div>
                <code style={{ fontSize: 11, color: "#94a3b8" }}>{bug.selector}</code>
              </div>

              <p style={{ margin: "8px 0 6px", fontSize: 13, color: "#e2e8f0" }}>
                {bug.shortReason}
              </p>

              <pre
                style={{
                  margin: 0,
                  padding: 8,
                  background: "#0b0f19",
                  borderRadius: 4,
                  fontSize: 11,
                  color: "#94a3b8",
                  overflowX: "auto",
                }}
              >
                {bug.htmlSnippet}
              </pre>
            </div>
          );
        })}
      </div>

      {/* Deep Fix Action */}
      {bugs.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <button
            onClick={handleGenerateDeepFix}
            disabled={generatingFix}
            style={{
              width: "100%",
              padding: "10px 16px",
              borderRadius: 6,
              border: "1px solid #3b82f6",
              background: generatingFix ? "#1e293b" : "#1d4ed8",
              color: "#ffffff",
              fontWeight: 700,
              cursor: generatingFix ? "not-allowed" : "pointer",
              fontSize: 13,
            }}
          >
            {generatingFix
              ? "Calling Firebase Cloud (Gemini 2.5 Flash)..."
              : `Generate Deep Fix (${bugs.length} issues via Cloud AI)`}
          </button>
        </div>
      )}

      {/* Patch Output */}
      {patchResult && (
        <div
          style={{
            marginTop: 16,
            background: "#0f172a",
            border: "1px solid #3b82f6",
            borderRadius: 8,
            padding: 12,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "#93c5fd" }}>
              UNIFIED DIFF PATCH (CLOUD • {patchResult.latencyMs}ms)
            </span>
          </div>
          <pre
            style={{
              margin: 0,
              fontSize: 12,
              color: "#e2e8f0",
              whiteSpace: "pre-wrap",
              overflowX: "auto",
            }}
          >
            {patchResult.patchDiff}
          </pre>
        </div>
      )}
    </div>
  );
}