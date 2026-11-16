/**
 * Chạy bên trong ngữ cảnh trang web (qua chrome.scripting.executeScript hoặc trực tiếp trên Web Dashboard)
 * để thu thập các phần tử DOM có nguy cơ lỗi A11y, SEO, UI, Dead Links.
 */
export function extractCandidateNodesFromDocument() {
  const candidates = [];

  // 1. Ảnh thiếu alt hoặc alt vô nghĩa
  document.querySelectorAll("img").forEach((img, idx) => {
    const alt = img.getAttribute("alt");
    if (alt === null || alt.trim() === "" || /^(image|img|photo|picture|\d+)$/i.test(alt.trim())) {
      candidates.push({
        id: `img-${idx}`,
        issueType: "a11y-alt",
        selector: img.id ? `img#${img.id}` : `img[src*="${(img.getAttribute("src") || "").slice(-25)}"]`,
        htmlSnippet: img.outerHTML.slice(0, 500),
      });
    }
  });

  // 2. Input / Select / Textarea thiếu nhãn (label / aria-label)
  document.querySelectorAll("input:not([type='hidden']):not([type='submit']), select, textarea").forEach((el, idx) => {
    const id = el.getAttribute("id");
    const hasLabel = id && document.querySelector(`label[for="${id}"]`);
    const hasAria = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby");
    if (!hasLabel && !hasAria) {
      candidates.push({
        id: `input-${idx}`,
        issueType: "a11y-labels",
        selector: id ? `#${id}` : `${el.tagName.toLowerCase()}[name="${el.getAttribute("name") || idx}"]`,
        htmlSnippet: el.outerHTML.slice(0, 500),
      });
    }
  });

  // 3. Link rỗng hoặc href="#" / javascript:void(0)
  document.querySelectorAll("a").forEach((a, idx) => {
    const href = (a.getAttribute("href") || "").trim();
    if (!href || href === "#" || href.startsWith("javascript:")) {
      candidates.push({
        id: `link-${idx}`,
        issueType: "dead-links",
        selector: a.id ? `a#${a.id}` : `a:nth-of-type(${idx + 1})`,
        htmlSnippet: a.outerHTML.slice(0, 500),
      });
    }
  });

  // 4. Button trống nội dung & thiếu aria-label
  document.querySelectorAll("button").forEach((btn, idx) => {
    const text = (btn.textContent || "").trim();
    const aria = btn.getAttribute("aria-label");
    if (!text && !aria) {
      candidates.push({
        id: `btn-${idx}`,
        issueType: "a11y-button",
        selector: btn.id ? `button#${btn.id}` : `button:nth-of-type(${idx + 1})`,
        htmlSnippet: btn.outerHTML.slice(0, 500),
      });
    }
  });

  return candidates.slice(0, 12); // Giới hạn 12 phần tử/lượt quét để giữ tốc độ phản hồi dưới 3s
}

/**
 * Dữ liệu DOM mẫu dùng khi test trực tiếp ở chế độ Web Dashboard (không qua Extension)
 */
export const SAMPLE_CANDIDATES = [
  {
    id: "sample-1",
    issueType: "a11y-alt",
    selector: "img.hero-banner",
    htmlSnippet: '<img class="hero-banner" src="/assets/promo-2026.png" alt="image">',
  },
  {
    id: "sample-2",
    issueType: "a11y-labels",
    selector: "input[name='email_signup']",
    htmlSnippet: '<input type="email" name="email_signup" placeholder="Enter work email" class="form-ctrl">',
  },
  {
    id: "sample-3",
    issueType: "dead-links",
    selector: "a.cta-pricing",
    htmlSnippet: '<a href="#" class="cta-pricing">View Enterprise Pricing</a>',
  },
];