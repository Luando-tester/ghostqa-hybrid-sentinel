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

// Chỉ bật App Check Debug Token khi đang chạy ở localhost (tuyệt đối không bật trên domain public như Railway)
const isLocalhost =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

if (isLocalhost && import.meta.env.VITE_APPCHECK_DEBUG === "true") {
  self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
}

const app = initializeApp(firebaseConfig);

// Khởi tạo App Check chỉ khi có reCAPTCHA Enterprise Site Key hợp lệ
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

// 1. Model Hybrid: Ưu tiên On-Device (Gemini Nano), tự động fallback sang Cloud (gemini-3.8-flash)
export const localFirstModel = getGenerativeModel(ai, {
  mode: InferenceMode.PREFER_ON_DEVICE,
  inCloudParams: {
    model: "gemini-3.8-flash",
  },
});

// 2. Model Cloud chuyên sâu: Chỉ chạy trên Cloud (InferenceMode.ONLY_IN_CLOUD)
export const cloudDeepModel = getGenerativeModel(ai, {
  mode: InferenceMode.ONLY_IN_CLOUD,
  inCloudParams: {
    model: "gemini-3.8-flash",
  },
});

let deviceModelInitPromise = null;

/**
 * BẮT BUỘC gọi sau khi user tương tác (ví dụ trong handler nút Start Scan)
 * và TRƯỚC khi gọi localFirstModel.generateContent().
 */
export async function ensureDeviceModelInitialized(onProgress) {
  if (!isFirebaseConfigured) {
    return { ready: false, reason: "Chưa cấu hình Firebase API key." };
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
          } else if (typeof event === "number") {
            onProgress?.(`Đang tải model Gemini Nano: ${Math.round(event * 100)}%`);
          }
        },
      });
      onProgress?.("On-Device Gemini Nano đã sẵn sàng.");
      return { ready: true, reason: "On-Device Gemini Nano sẵn sàng." };
    } catch (err) {
      deviceModelInitPromise = null;
      const msg = `On-device không khả dụng (${err.message}). Sẽ dùng Cloud Fallback.`;
      onProgress?.(msg);
      return { ready: false, reason: msg };
    }
  })();

  return deviceModelInitPromise;
}

/**
 * Kiểm tra nhanh khả năng hỗ trợ Prompt API trước khi user bấm nút
 */
export async function checkOnDeviceSupport() {
  try {
    if (typeof self !== "undefined" && "LanguageModel" in self) {
      const availability = await self.LanguageModel.availability();
      const ready = availability === "readily" || availability === "available" || availability === "downloadable";
      return {
        supported: ready,
        status: availability,
        reason: ready
          ? `Chrome Prompt API khả dụng (${availability}). Bấm Start Scan để khởi tạo model.`
          : `Gemini Nano không khả dụng (${availability}). Sẽ tự động fallback sang Cloud.`,
      };
    }
    return {
      supported: false,
      status: "unsupported",
      reason: "Trình duyệt không hỗ trợ Prompt API (cần Chrome Desktop v139+). Sẽ dùng Cloud Fallback.",
    };
  } catch (err) {
    return {
      supported: false,
      status: "error",
      reason: `Lỗi kiểm tra Prompt API: ${err.message}. Sẽ fallback sang Cloud.`,
    };
  }
}