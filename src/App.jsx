import React, { useState, useEffect } from "react";
import { checkOnDeviceSupport, isFirebaseConfigured } from "./firebase/hybridClient";
import {
  extractCandidateNodesFromDocument,
  SAMPLE_CANDIDATES,
} from "./scanner/domExtractor";
import {
  prepareHybridScanner,
  triageElementOnDevice,
  generateCloudPatch,
} from "./scanner/hybridAuditor";

const ESTIMATED_CLOUD_COST_PER_CHECK_USD = 0.0004;

export default function App() {
  const [url, setUrl] = useState("http://localhost:3000");
  const [deviceInfo, setDeviceInfo] = useState({
    supported: false,
    status: "checking",
    reason: "Đang kiểm tra Chrome Gemini Nano...",
  });
  const [initProgress, setInitProgress] = useState("");
  const [scanning, setScanning] = useState(false);
  const [results, setResults] = useState([]);
  const [onDeviceCount, setOnDeviceCount] = useState(0);
  const [generatingFix, setGeneratingFix] = useState(false);
  const [patchResult, setPatchResult] = useState(null);

  useEffect(() => {
    checkOnDeviceSupport().then(setDeviceInfo);

    if (typeof chrome !== "undefined" && chrome.tabs?.query) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs?.[0]?.url) setUrl(tabs[0].url);
      });
    }
  }, []);

  async function handleStartScan() {
    setScanning(true);
    setResults([]);
    setPatchResult(null);

    // Gọi initializeDeviceModel() sau hành động click của người dùng
    await prepareHybridScanner((progressMsg) => {
      setInitProgress(progressMsg);
    });

    let candidates = [];

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

    if (candidates.length === 0) {
      const localDom = extractCandidateNodesFromDocument();
      candidates = localDom.length > 0 ? localDom : SAMPLE_CANDIDATES;
    }

    const collected = [];

    for (const item of candidates) {
      const verdict = await triageElementOnDevice(
        item.htmlSnippet,
        item.issueType,
        setInitProgress
      );

      // Chỉ đếm local check khi chạy thành công bằng on-device và không có lỗi
      if (verdict.inferenceSource === "on-device" && !verdict.error) {
        setOnDeviceCount((prev) => prev + 1);
      }

      if (verdict.isBug || verdict.error) {
        collected.push({ ...item, ...verdict });
        setResults([...collected]);
      }
    }

    setScanning(false);
  }

  const validBugs = results.filter((r) => r.isBug && !r.error);

  async function handleGenerateDeepFix() {
    if (validBugs.length === 0) return;
    setGeneratingFix(true);
    try {
      const res = await generateCloudPatch(url, validBugs);
      setPatchResult(res);
    } finally {
      setGeneratingFix(false);
    }
  }

  const savedUsd = (onDeviceCount * ESTIMATED_CLOUD_COST_PER_CHECK_USD).toFixed(4);

  function getBadgeStyle(source) {
    if (source === "on-device") {
      return {
        label: "ON-DEVICE",
        background: "#064e3b",
        color: "#34d399",
        border: "1px solid #10b981",
      };
    }
    if (source === "cloud") {
      return {
        label: "CLOUD",
        background: "#1e3a8a",
        color: "#93c5fd",
        border: "1px solid #3b82f6",
      };
    }
    if (source === "error") {
      return {
        label: "AI ERROR",
        background: "#450a0a",
        color: "#fca5a5",
        border: "1px solid #ef4444",
      };
    }
    return {
      label: "DEMO",
      background: "#3f3f46",
      color: "#d4d4d8",
      border: "1px solid #71717a",
    };
  }

  return (
    <div style={{ maxWidth: 760, minWidth: 420, margin: "0 auto", padding: 16 }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, color: "#f8fafc" }}>
            GhostQA Local-First Sentinel
          </h2>
          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>
            {initProgress || deviceInfo.reason}
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

      {/* Results List */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {results.map((item) => {
          const badge = getBadgeStyle(item.inferenceSource);
          const isError = Boolean(item.error);

          return (
            <div
              key={item.id}
              style={{
                background: isError ? "#1f1216" : "#111827",
                border: isError ? "1px solid #7f1d1d" : "1px solid #1f2937",
                borderRadius: 8,
                padding: 12,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    style={{
                      padding: "2px 8px",
                      borderRadius: 999,
                      fontSize: 11,
                      fontWeight: 700,
                      background: badge.background,
                      color: badge.color,
                      border: badge.border,
                    }}
                  >
                    {badge.label} • {item.latencyMs}ms
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: isError ? "#f87171" : "#f59e0b",
                    }}
                  >
                    {isError ? `[FAILED] ${item.issueType}` : `[${item.severity.toUpperCase()}] ${item.issueType}`}
                  </span>
                </div>
                <code style={{ fontSize: 11, color: "#94a3b8" }}>{item.selector}</code>
              </div>

              <p style={{ margin: "8px 0 6px", fontSize: 13, color: isError ? "#fecaca" : "#e2e8f0" }}>
                {item.error ? `Error: ${item.error}` : item.shortReason}
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
                {item.htmlSnippet}
              </pre>
            </div>
          );
        })}
      </div>

      {/* Deep Fix Action */}
      {validBugs.length > 0 && (
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
              : `Generate Deep Fix (${validBugs.length} issues via Cloud AI)`}
          </button>
        </div>
      )}

      {/* Patch Output */}
      {patchResult && (
        <div
          style={{
            marginTop: 16,
            background: patchResult.error ? "#1f1216" : "#0f172a",
            border: patchResult.error ? "1px solid #ef4444" : "1px solid #3b82f6",
            borderRadius: 8,
            padding: 12,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: patchResult.error ? "#fca5a5" : "#93c5fd",
              }}
            >
              {patchResult.error
                ? `CLOUD DEEP FIX FAILED • ${patchResult.latencyMs}ms`
                : `UNIFIED DIFF PATCH (CLOUD • ${patchResult.latencyMs}ms)`}
            </span>
          </div>
          <pre
            style={{
              margin: 0,
              fontSize: 12,
              color: patchResult.error ? "#fecaca" : "#e2e8f0",
              whiteSpace: "pre-wrap",
              overflowX: "auto",
            }}
          >
            {patchResult.error ? patchResult.error : patchResult.patchDiff}
          </pre>
        </div>
      )}
    </div>
  );
}