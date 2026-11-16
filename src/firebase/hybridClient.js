import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode,
} from "firebase/ai";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "YOUR_FIREBASE_API_KEY",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "YOUR_PROJECT_ID",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "YOUR_SENDER_ID",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "YOUR_APP_ID",
};

export const isFirebaseConfigured =
  firebaseConfig.apiKey !== "YOUR_FIREBASE_API_KEY" &&
  firebaseConfig.projectId !== "YOUR_PROJECT_ID";

// Nguồn model chính thức: https://firebase.google.com/docs/ai-logic/models
export const CLOUD_MODEL_CANDIDATES = [
  "gemini-2.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-3-flash-preview",
  "gemini-2.5-pro",
];

// Chỉ bật App Check Debug Token khi đang chạy ở localhost (tuyệt đối không bật trên domain public như Railway)
const isLocalhost =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

if (isLocalhost && import.meta.env.VITE_APPCHECK_DEBUG === "true") {
  self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
}

const app = initializeApp(firebaseConfig);

if (isFirebaseConfigured && import.meta.env.VITE_RECAPTCHA_SITE_KEY) {
  try {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(import.meta.env.VITE_RECAPTCHA_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
  } catch (err) {
    console.warn("App Check init skipped:", err.message);
  }
}

const ai = getAI(app, { backend: new GoogleAIBackend() });

// 1. Model Hybrid: Ưu tiên On-Device (Gemini Nano), tự động fallback sang Cloud
export const localFirstModel = getGenerativeModel(ai, {
  mode: InferenceMode.PREFER_ON_DEVICE,
  inCloudParams: {
    model: CLOUD_MODEL_CANDIDATES[0],
  },
});

// 2. Tạo instance Cloud model theo tên model đã kiểm chứng
export function getCloudModel(modelName = CLOUD_MODEL_CANDIDATES[0]) {
  return getGenerativeModel(ai, {
    mode: InferenceMode.ONLY_IN_CLOUD,
    inCloudParams: {
      model: modelName,
    },
  });
}

export const cloudDeepModel = getCloudModel(CLOUD_MODEL_CANDIDATES[0]);

/**
 * Kiểm tra chính xác trạng thái availability của Chrome Prompt API.
 * CHỈ coi là sẵn sàng chạy ngay khi status là "readily" hoặc "available".
 * Nếu là "downloadable" / "downloading" -> không ép tải ngầm 1.5GB lúc scan mà chuyển sang Cloud.
 */
export async function checkOnDeviceSupport() {
  try {
    if (typeof self !== "undefined" && "LanguageModel" in self) {
      const availability = await self.LanguageModel.availability();
      const readyNow = availability === "readily" || availability === "available";

      if (readyNow) {
        return {
          supported: true,
          status: availability,
          reason: `On-Device Gemini Nano sẵn sàng (${availability}).`,
        };
      }
      if (availability === "downloadable" || availability === "downloading") {
        return {
          supported: false,
          status: availability,
          reason: `Gemini Nano chưa tải xong (${availability}). Dùng Cloud AI để tránh chờ tải 1.5GB.`,
        };
      }
      return {
        supported: false,
        status: availability,
        reason: `Gemini Nano không khả dụng trên thiết bị này (${availability}). Dùng Cloud AI.`,
      };
    }

    return {
      supported: false,
      status: "unsupported",
      reason: "Trình duyệt không bật Prompt API (cần Chrome Desktop v139+). Dùng Cloud AI.",
    };
  } catch (err) {
    return {
      supported: false,
      status: "error",
      reason: `Lỗi kiểm tra Prompt API (${err.message}). Dùng Cloud AI.`,
    };
  }
}

let deviceModelInitPromise = null;

/**
 * BẮT BUỘC gọi sau khi user tương tác (click Start Scan) và TRƯỚC generateContent().
 * Nếu availability không phải "readily"/"available" thì thoát ngay (0ms) để chạy Cloud.
 */
export async function ensureDeviceModelInitialized(onProgress) {
  if (!isFirebaseConfigured) {
    return { ready: false, reason: "Chưa cấu hình Firebase API key." };
  }

  const support = await checkOnDeviceSupport();
  if (!support.supported) {
    return { ready: false, reason: support.reason };
  }

  if (deviceModelInitPromise) {
    return deviceModelInitPromise;
  }

  deviceModelInitPromise = (async () => {
    try {
      onProgress?.("Đang khởi tạo On-Device Gemini Nano...");
      await localFirstModel.initializeDeviceModel({
        onProgress: (event) => {
          if (event && typeof event.loaded === "number" && typeof event.total === "number" && event.total > 0) {
            const pct = Math.round((event.loaded / event.total) * 100);
            onProgress?.(`Đang tải model Gemini Nano: ${pct}%`);
          }
        },
      });
      return { ready: true, reason: "On-Device Gemini Nano sẵn sàng." };
    } catch (err) {
      deviceModelInitPromise = null;
      const msg = `On-device init thất bại (${err.message}). Chuyển sang Cloud AI.`;
      onProgress?.(msg);
      return { ready: false, reason: msg };
    }
  })();

  return deviceModelInitPromise;
}