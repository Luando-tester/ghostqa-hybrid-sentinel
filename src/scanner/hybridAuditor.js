import {
  localFirstModel,
  cloudDeepModel,
  ensureDeviceModelInitialized,
  isFirebaseConfigured,
} from "../firebase/hybridClient";

let lastDeviceInitStatus = { ready: false, reason: "Chưa khởi tạo" };

/**
 * Gọi hàm này đầu tiên trong handler của nút Start Scan (sau user gesture)
 * trước khi gọi triageElementOnDevice().
 */
export async function prepareHybridScanner(onProgress) {
  lastDeviceInitStatus = await ensureDeviceModelInitialized(onProgress);
  return lastDeviceInitStatus;
}

/**
 * Triage từng phần tử DOM bằng mô hình Hybrid (PREFER_ON_DEVICE -> fallback ONLY_IN_CLOUD).
 * Trả về: { isBug, severity, shortReason, inferenceSource, latencyMs }
 */
export async function triageElementOnDevice(htmlSnippet, issueType, onProgress) {
  const t0 = performance.now();

  // Đảm bảo đã chạy initializeDeviceModel() sau thao tác click trước khi generateContent()
  if (!lastDeviceInitStatus.ready && isFirebaseConfigured) {
    await prepareHybridScanner(onProgress);
  }

  // Nếu chưa điền Firebase config và không có on-device model -> trả demo fallback để test UI
  if (!isFirebaseConfigured && !lastDeviceInitStatus.ready) {
    return {
      isBug: true,
      severity: "medium",
      shortReason: `[Demo Fallback] ${issueType} detected (chưa cấu hình Firebase API key).`,
      inferenceSource: "on-device",
      latencyMs: Math.max(4, Math.round(performance.now() - t0)),
    };
  }

  const prompt = `You are a strict QA & Accessibility auditor. Inspect this HTML element for "${issueType}".
Respond ONLY with valid JSON (no markdown fences):
{"isBug": true, "severity": "low"|"medium"|"high", "shortReason": "concise explanation under 15 words"}

HTML:
${htmlSnippet.slice(0, 600)}`;

  try {
    const result = await localFirstModel.generateContent(prompt);
    const latencyMs = Math.round(performance.now() - t0);
    const rawText = result.response.text().replace(/```json|```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = {
        isBug: true,
        severity: "medium",
        shortReason: rawText.slice(0, 90) || `Potential ${issueType} violation.`,
      };
    }

    const sdkSource = result.response?.inferenceSource;
    const inferenceSource =
      sdkSource === "on-device" || sdkSource === "cloud"
        ? sdkSource
        : lastDeviceInitStatus.ready
        ? "on-device"
        : "cloud";

    return {
      isBug: Boolean(parsed.isBug),
      severity: ["low", "medium", "high"].includes(parsed.severity) ? parsed.severity : "medium",
      shortReason: parsed.shortReason || `Detected ${issueType} issue.`,
      inferenceSource,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - t0);
    return {
      isBug: true,
      severity: "medium",
      shortReason: `Fallback audit (${issueType}): ${err.message.slice(0, 60)}`,
      inferenceSource: lastDeviceInitStatus.ready ? "on-device" : "cloud",
      latencyMs,
    };
  }
}

/**
 * Gọi Cloud Gemini 2.5 Flash (ONLY_IN_CLOUD) để phân tích sâu và sinh Unified Diff Patch.
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
      patchDiff: `# [DEMO MODE - Điền VITE_FIREBASE_API_KEY để gọi Gemini 2.5 Flash thật]\n\n${mockDiff}`,
      inferenceSource: "cloud",
      latencyMs: Math.round(performance.now() - t0),
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

  const result = await cloudDeepModel.generateContent(prompt);
  const latencyMs = Math.round(performance.now() - t0);

  return {
    patchDiff: result.response.text(),
    inferenceSource: "cloud",
    latencyMs,
  };
}