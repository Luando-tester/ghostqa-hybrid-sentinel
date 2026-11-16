import {
  localFirstModel,
  cloudDeepModel,
  ensureDeviceModelInitialized,
  isFirebaseConfigured,
} from "../firebase/hybridClient";

const ON_DEVICE_WARMUP_TIMEOUT_MS = 35000;
const ON_DEVICE_STEP_TIMEOUT_MS = 12000;
const CLOUD_RESCUE_TIMEOUT_MS = 15000;

let lastDeviceInitStatus = { ready: false, reason: "Chưa khởi tạo" };
let onDeviceHealthy = false;
let isWarmedUp = false;

function withTimeout(promise, ms, label = "timeout") {
  let timerId;
  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      reject(new Error(`${label} sau ${Math.round(ms / 1000)}s`));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timerId);
  });
}

export function isOnDeviceActive() {
  return onDeviceHealthy;
}

/**
 * Gọi hàm này đầu tiên trong handler của nút Start Scan (sau user gesture).
 * Khởi tạo device model + chạy 1 warm-up prompt ngắn để nạp trọng số vào RAM/VRAM.
 */
export async function prepareHybridScanner(onProgress) {
  lastDeviceInitStatus = await ensureDeviceModelInitialized(onProgress);

  if (!lastDeviceInitStatus.ready) {
    onDeviceHealthy = false;
    return { ready: false, onDeviceHealthy: false, reason: lastDeviceInitStatus.reason };
  }

  if (!isWarmedUp) {
    try {
      onProgress?.("Đang nạp Gemini Nano vào bộ nhớ (warm-up)...");
      await withTimeout(
        localFirstModel.generateContent("Reply with one word: OK"),
        ON_DEVICE_WARMUP_TIMEOUT_MS,
        "On-device warm-up timeout"
      );
      isWarmedUp = true;
      onDeviceHealthy = true;
      onProgress?.("On-Device Gemini Nano đã nạp xong & sẵn sàng.");
    } catch (err) {
      onDeviceHealthy = false;
      onProgress?.(`On-device phản hồi chậm (${err.message}). Tự động chuyển sang Cloud Rescue.`);
    }
  }

  return {
    ready: true,
    onDeviceHealthy,
    reason: onDeviceHealthy
      ? "On-Device Gemini Nano sẵn sàng."
      : "Đang dùng Cloud AI (gemini-3.8-flash) do On-Device chậm.",
  };
}

/**
 * Chẩn đoán độc lập 2 đường: Cloud (ONLY_IN_CLOUD) và On-Device (PREFER_ON_DEVICE)
 */
export async function runDiagnosticCheck() {
  if (!isFirebaseConfigured) {
    return {
      cloud: { ok: false, latencyMs: 0, detail: "Chưa điền Firebase Config trong .env" },
      onDevice: { ok: false, latencyMs: 0, detail: "Chưa điền Firebase Config trong .env" },
    };
  }

  // 1. Test riêng đường Cloud (ONLY_IN_CLOUD)
  const cloudCheck = (async () => {
    const t0 = performance.now();
    try {
      const res = await withTimeout(
        cloudDeepModel.generateContent("Reply with one word: PONG"),
        CLOUD_RESCUE_TIMEOUT_MS,
        "Cloud timeout"
      );
      return {
        ok: true,
        latencyMs: Math.round(performance.now() - t0),
        detail: `OK (${res.response.text().trim().slice(0, 20)})`,
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - t0),
        detail: err?.message || "Cloud error",
      };
    }
  })();

  // 2. Test riêng đường On-Device
  const deviceCheck = (async () => {
    const t0 = performance.now();
    try {
      const init = await ensureDeviceModelInitialized();
      if (!init.ready) {
        return {
          ok: false,
          latencyMs: Math.round(performance.now() - t0),
          detail: init.reason,
        };
      }
      const res = await withTimeout(
        localFirstModel.generateContent("Reply with one word: PONG"),
        ON_DEVICE_WARMUP_TIMEOUT_MS,
        "On-device timeout"
      );
      isWarmedUp = true;
      onDeviceHealthy = true;
      return {
        ok: true,
        latencyMs: Math.round(performance.now() - t0),
        detail: `OK (${res.response.text().trim().slice(0, 20)})`,
      };
    } catch (err) {
      onDeviceHealthy = false;
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - t0),
        detail: err?.message || "On-device error",
      };
    }
  })();

  const [cloud, onDevice] = await Promise.all([cloudCheck, deviceCheck]);
  return { cloud, onDevice };
}

function parseAuditJson(rawText, issueType) {
  const cleaned = rawText.replace(/```json|```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    return {
      isBug: Boolean(parsed.isBug),
      severity: ["low", "medium", "high"].includes(parsed.severity) ? parsed.severity : "medium",
      shortReason: parsed.shortReason || `Detected ${issueType} issue.`,
    };
  } catch {
    return {
      isBug: true,
      severity: "medium",
      shortReason: cleaned.slice(0, 90) || `Potential ${issueType} violation.`,
    };
  }
}

/**
 * Triage phần tử DOM:
 * - Bước 1: Nếu onDeviceHealthy == true, chạy localFirstModel với timeout 12s.
 * - Bước 2: Nếu on-device timeout/lỗi (hoặc không khỏe), tự động fallback sang cloudDeepModel (timeout 15s).
 * - Chỉ trả về inferenceSource: "error" nếu CẢ HAI đường đều thất bại.
 */
export async function triageElementOnDevice(htmlSnippet, issueType, onProgress) {
  const t0 = performance.now();

  if (!isFirebaseConfigured && !lastDeviceInitStatus.ready) {
    return {
      isBug: true,
      severity: "medium",
      shortReason: `[Demo Fallback] ${issueType} detected (chưa cấu hình Firebase API key).`,
      inferenceSource: "demo",
      latencyMs: Math.max(4, Math.round(performance.now() - t0)),
      error: null,
    };
  }

  const prompt = `You are a strict QA & Accessibility auditor. Inspect this HTML element for "${issueType}".
Respond ONLY with valid JSON (no markdown fences):
{"isBug": true, "severity": "low"|"medium"|"high", "shortReason": "concise explanation under 15 words"}

HTML:
${htmlSnippet.slice(0, 600)}`;

  // Đường 1: Thử On-Device (nếu đang khỏe) với timeout 12s
  if (onDeviceHealthy) {
    try {
      const tLocal = performance.now();
      const result = await withTimeout(
        localFirstModel.generateContent(prompt),
        ON_DEVICE_STEP_TIMEOUT_MS,
        "On-device timeout"
      );
      const latencyMs = Math.round(performance.now() - tLocal);
      const parsed = parseAuditJson(result.response.text(), issueType);
      const sdkSource = result.response?.inferenceSource;

      return {
        ...parsed,
        inferenceSource: sdkSource === "cloud" ? "cloud" : "on-device",
        latencyMs,
        error: null,
      };
    } catch (localErr) {
      // On-device bị chậm/kẹt -> hạ cờ để các element sau đi thẳng Cloud, đồng thời cứu hộ element hiện tại
      onDeviceHealthy = false;
      onProgress?.(`On-device chậm (${localErr.message}), chuyển sang Cloud...`);
    }
  }

  // Đường 2: Cloud Rescue (ONLY_IN_CLOUD) với timeout 15s
  try {
    const tCloud = performance.now();
    const cloudResult = await withTimeout(
      cloudDeepModel.generateContent(prompt),
      CLOUD_RESCUE_TIMEOUT_MS,
      "Cloud timeout"
    );
    const latencyMs = Math.round(performance.now() - tCloud);
    const parsed = parseAuditJson(cloudResult.response.text(), issueType);

    return {
      ...parsed,
      inferenceSource: "cloud",
      latencyMs,
      error: null,
    };
  } catch (cloudErr) {
    const latencyMs = Math.round(performance.now() - t0);
    const errorMsg = cloudErr?.message || "Unknown AI inference error";
    return {
      isBug: false,
      severity: "high",
      shortReason: `AI audit failed (${issueType}): ${errorMsg}`,
      inferenceSource: "error",
      latencyMs,
      error: errorMsg,
    };
  }
}

/**
 * Gọi Cloud Gemini (ONLY_IN_CLOUD) để phân tích sâu và sinh Unified Diff Patch.
 */
export async function generateCloudPatch(targetUrl, confirmedBugs) {
  const t0 = performance.now();

  if (!isFirebaseConfigured) {
    const mockDiff = confirmedBugs
      .map(
        (b, i) =>
          `--- a/index.html\n+++ b/index.html\n@@ -${10 + i * 5},1 +${10 + i * 5},1 @@\n- ${b.htmlSnippet}\n+ <!-- [FIXED ${b.issueType}] --> ${b.htmlSnippet.replace(
            ">",
            ' aria-label="Accessible Element">'
          )}`
      )
      .join("\n\n");

    return {
      patchDiff: `# [DEMO MODE - Điền VITE_FIREBASE_API_KEY để gọi Cloud AI thật]\n\n${mockDiff}`,
      inferenceSource: "demo",
      latencyMs: Math.round(performance.now() - t0),
      error: null,
    };
  }

  const prompt = `You are a Principal Frontend & QA Engineer.
Target URL: ${targetUrl}
Confirmed DOM issues:
${JSON.stringify(
  confirmedBugs.map((b) => ({
    selector: b.selector,
    issueType: b.issueType,
    severity: b.severity,
    reason: b.shortReason,
    html: b.htmlSnippet,
  })),
  null,
  2
)}

Generate a clean, production-ready unified diff patch (\`\`\`diff ... \`\`\`) fixing all confirmed issues above. Keep explanations minimal.`;

  try {
    const result = await withTimeout(
      cloudDeepModel.generateContent(prompt),
      CLOUD_RESCUE_TIMEOUT_MS,
      "Cloud patch timeout"
    );
    const latencyMs = Math.round(performance.now() - t0);

    return {
      patchDiff: result.response.text(),
      inferenceSource: "cloud",
      latencyMs,
      error: null,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - t0);
    return {
      patchDiff: null,
      inferenceSource: "error",
      latencyMs,
      error: err?.message || "Failed to generate cloud patch",
    };
  }
}