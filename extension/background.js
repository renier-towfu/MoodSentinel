// MoodSentinel Extension — background.js
// v6.4.0

const POLL_INTERVAL_SECONDS = 5;
let API_BASE = "http://localhost:8000";
let isProcessing = false;

function updateBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

async function autoDetectNgrokUrl() {
  try {
    const res = await fetch("http://localhost:8000/api/ngrok-url", {
      headers: { "ngrok-skip-browser-warning": "true" }
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.url && data.url.startsWith("https://")) {
      API_BASE = data.url;
      await chrome.storage.local.set({ apiBase: data.url });
      console.log("[MoodSentinel] Auto-detected ngrok URL:", data.url);
    } else {
      console.warn("[MoodSentinel] ngrok URL not available — using saved or localhost");
    }
  } catch (err) {
    console.warn("[MoodSentinel] ngrok auto-detect failed:", err.message);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create("pollBackend", { periodInMinutes: POLL_INTERVAL_SECONDS / 60 });
  console.log("[MoodSentinel] Installed. Polling every", POLL_INTERVAL_SECONDS, "seconds.");
  await loadSettings();
  await autoDetectNgrokUrl();
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create("pollBackend", { periodInMinutes: POLL_INTERVAL_SECONDS / 60 });
  await loadSettings();
  await autoDetectNgrokUrl();
});

async function loadSettings() {
  const result = await chrome.storage.local.get(["apiBase"]);
  if (result.apiBase) {
    API_BASE = result.apiBase;
    console.log("[MoodSentinel] Loaded saved API base:", API_BASE);
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "pollBackend") await pollForPendingJob();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "SET_API_BASE") {
    API_BASE = msg.apiBase;
    chrome.storage.local.set({ apiBase: msg.apiBase });
    sendResponse({ ok: true });
  }
  if (msg.type === "GET_STATUS") {
    sendResponse({ isProcessing, apiBase: API_BASE });
  }
  if (msg.type === "COMMENTS_SCRAPED") {
    handleScrapedComments(msg.jobId, msg.comments, msg.url);
    sendResponse({ ok: true });
  }
  if (msg.type === "REFRESH_NGROK") {
    autoDetectNgrokUrl().then(() => sendResponse({ ok: true, apiBase: API_BASE }));
    return true;
  }
  return true;
});

async function pollForPendingJob() {
  if (isProcessing) return;
  try {
    const res = await fetch(`${API_BASE}/api/extension/pending`, {
      headers: { "ngrok-skip-browser-warning": "true" }
    });
    const job = await res.json();
    if (!job || !job.job_id || !job.post_url) return;

    console.log("[MoodSentinel] Got job:", job.job_id, job.post_url);
    isProcessing = true;
    updateBadge("...", "#4A90E2");
    chrome.runtime.sendMessage({ type: "JOB_STARTED", url: job.post_url }).catch(() => {});
    await processJob(job);
  } catch (err) {
    console.error("[MoodSentinel] Poll failed:", err.message);
  }
}

async function processJob(job) {
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: job.post_url, active: false });
    console.log("[MoodSentinel] Opened tab:", tab.id, "for URL:", job.post_url);
    await waitForTabLoad(tab.id, 30000);
    await sleep(6000);

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeCommentsFromPage,
      args: [job.job_id, job.max_comments || 500, API_BASE]
    });

    await waitForJobComplete(job.job_id, 900000);
  } catch (err) {
    console.error("[MoodSentinel] Job failed:", err.message);
    await markJobFailed(job.job_id, err.message);
  } finally {
    if (tab) {
      try { await chrome.tabs.remove(tab.id); } catch (_) {}
    }
    isProcessing = false;
    updateBadge("", "#4CAF50");
  }
}

// ── Injected into Facebook tab ────────────────────────────────────────────────
function scrapeCommentsFromPage(jobId, maxComments, apiBase) {

  const seen = new Set();
  const comments = [];

  const UI_NOISE = new Set([
    "Like", "Reply", "Share", "Comment", "See more", "See less",
    "View more comments", "View previous comments", "Most relevant",
    "All comments", "Hide", "Edit", "Follow", "Unfollow", "Top fan",
    "Write a comment", "reactions", "comments", "shares", "Reels",
    "Most Relevant", "Newest", "All Comments", "See original",
    "See translation", "Edited", "Author"
  ]);

  const REACTION_WORDS = new Set([
    "Like", "Love", "Haha", "Wow", "Sad", "Angry", "Care"
  ]);

  // ── FIX (Issue 3): Emoji-aware text extractor ─────────────────────────────
  // Facebook renders emoji as <img alt="😂"> not as Unicode text nodes.
  // el.innerText skips <img> entirely, so emoji-only comments returned "".
  // This recursive walker collects text nodes AND img[alt] values together,
  // preserving the full visible text including emoji characters.
  function getTextWithEmoji(el) {
    let result = "";
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        result += node.textContent;
      } else if (node.nodeName === "IMG") {
        // Facebook encodes emoji as <img alt="😂" ...>
        const alt = node.getAttribute("alt");
        if (alt) result += alt;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        result += getTextWithEmoji(node); // recurse into child elements
      }
    }
    return result;
  }

  function findCommentContainer() {
    const dialog = document.querySelector("[role='dialog']");
    if (dialog && dialog.querySelectorAll("[role='article']").length > 1) {
      console.log("[MoodSentinel] Container: dialog (photo lightbox)");
      return dialog;
    }
    for (const el of document.querySelectorAll("[role='complementary']")) {
      if (el.querySelectorAll("[role='article']").length > 1) {
        console.log("[MoodSentinel] Container: complementary");
        return el;
      }
    }
    console.log("[MoodSentinel] Container: document");
    return document;
  }

  // ── FIX (Issue 1): Improved author name extraction ────────────────────────
  // Original: queried all profile links and took the first 1–80 char result,
  // which frequently returned reaction-button links, "Suggested for you" labels,
  // or other profile-adjacent UI elements instead of the actual commenter name.
  // Fix: prefer the first <strong> inside h3/h4 (Facebook's reliable author
  // heading), then fall back to profile links that also contain a <strong>.
  // Added guards to reject timestamps (/^\d/) and known UI action words.
  function getAuthorName(article) {
    // Facebook puts commenter name in <strong> inside h3/h4 in the article header
    const strong = article.querySelector("h3 strong, h4 strong, strong");
    if (strong) {
      const text = strong.innerText?.trim();
      if (
        text &&
        text.length > 1 &&
        text.length < 80 &&
        !/^\d/.test(text) &&                          // reject timestamps like "1m"
        !/\b(like|reply|share|comment)\b/i.test(text) // reject UI action words
      ) {
        return text;
      }
    }
    // Fallback: profile links, but only those that also contain a <strong> child
    // or whose text does not look like a timestamp or UI label
    const links = article.querySelectorAll(
      "a[href*='/profile.php'], a[href*='facebook.com/']"
    );
    for (const link of links) {
      const text =
        link.querySelector("strong")?.innerText?.trim() ??
        link.innerText?.trim();
      if (
        text &&
        text.length > 1 &&
        text.length < 80 &&
        !/^\d/.test(text) &&
        !/\b(like|reply|share|comment)\b/i.test(text)
      ) {
        return text;
      }
    }
    return null;
  }

  // ── FIX (Issue 1 + 3): Improved comment text extraction ───────────────────
  // Original issues:
  //   1. Candidate dir=auto elements included the author name region, so the
  //      longest-text heuristic often picked the entire header block
  //      (name + "1m" + "Like" + "Reply" concatenated) as the comment.
  //   2. innerText was used everywhere, which silently drops <img alt="😂">
  //      emoji, causing emoji-only comments to extract as empty strings.
  // Fixes:
  //   1. Check for Facebook's data-ad-comet-preview="message" wrapper first —
  //      this is the most reliable selector for the comment body.
  //   2. Locate the author header element and exclude any dir=auto candidates
  //      that are contained within it, preventing name bleed.
  //   3. Replace innerText with getTextWithEmoji() in candidate evaluation
  //      so emoji characters are preserved from <img alt> attributes.
  //   4. Normalise both sides of the author-strip comparison to NFC to handle
  //      Unicode directional marks and invisible characters that break startsWith.
  //   5. Fallback line-splitting also uses getTextWithEmoji() and adds a guard
  //      that rejects lines matching the "Name1mLikeReply" concatenation pattern.
  function extractCommentText(article, authorName) {
    // Priority 1: Facebook's semantic comment body wrapper (most reliable)
    const messageDiv = article.querySelector(
      "[data-ad-comet-preview='message'], [data-ad-preview='message']"
    );
    if (messageDiv) {
      // FIX (Issue 3): use emoji-aware extractor instead of innerText
      return getTextWithEmoji(messageDiv).trim();
    }

    // Priority 2: leaf-level dir=auto elements, with author-region exclusion
    // FIX (Issue 1): find the header element so we can exclude its subtree
    const headerEl = article.querySelector(
      "h3, h4, [data-testid*='author'], [data-testid*='story-subtitle']"
    );

    const allDirAuto = Array.from(
      article.querySelectorAll("div[dir='auto'], span[dir='auto']")
    );

    const candidates = allDirAuto.filter(el => {
      if (el.closest("a")) return false;
      // FIX (Issue 1): exclude any dir=auto element that lives inside the
      // author header region — this prevents name text from being selected
      if (headerEl && headerEl.contains(el)) return false;
      // Keep only leaf-level dir=auto (not ancestors of other dir=auto)
      if (allDirAuto.some(other => other !== el && el.contains(other))) return false;
      return true;
    });

    let bestText = "";
    for (const el of candidates) {
      // FIX (Issue 3): use emoji-aware extractor so <img alt="😂"> is captured
      const raw = getTextWithEmoji(el).trim();
      if (!raw || raw.length < 2) continue;
      if (/^\d+[smhdwy]$/.test(raw)) continue;
      if (UI_NOISE.has(raw)) continue;
      if (/^\d+(\.\d+)?[KMk]?$/.test(raw)) continue;
      if (raw.length > bestText.length) bestText = raw;
    }

    // FIX (Issue 1): normalise both sides to NFC before stripping author prefix.
    // Without NFC normalisation, invisible Unicode directional marks or
    // variation selectors cause startsWith to silently fail, leaving the full
    // "AuthorName comment body" string intact.
    if (authorName && bestText) {
      const normBest = bestText.normalize("NFC");
      const normName = authorName.normalize("NFC");
      if (normBest.startsWith(normName)) {
        bestText = normBest
          .slice(normName.length)
          // strip leading invisible Unicode chars that Facebook injects
          .replace(/^[\s\u200B\u200C\u200D\uFEFF\u00A0]+/, "")
          .trim();
      }
    }

    // Fallback: line-splitting on the full article text
    if (!bestText || bestText.length < 2) {
      // FIX (Issue 3): use getTextWithEmoji so emoji in fallback path is kept
      const fullText = getTextWithEmoji(article).trim();
      const lines = fullText.split("\n")
        .map(l => l.trim())
        .filter(l => l.length > 1)
        .filter(l => !UI_NOISE.has(l))
        .filter(l => !REACTION_WORDS.has(l))
        .filter(l => !/^\d+[smhdwy]$/.test(l))
        .filter(l => !/^\d+(\.\d+)?[KMk]?$/.test(l))
        .filter(l => l !== authorName)
        // FIX (Issue 1): reject the "Name1mLikeReply" concatenation pattern.
        // This arises when Facebook collapses the header row into one innerText
        // line with no whitespace separators between name, timestamp, and actions.
        .filter(l => !/\d+[smhdwy](Like|Reply|Share|Comment)/i.test(l))
        // FIX (Issue 1): also reject lines that START with the author name,
        // catching cases where the name was not stripped by the earlier check
        .filter(l => {
          if (!authorName) return true;
          return !l.normalize("NFC").startsWith(authorName.normalize("NFC"));
        });
      const candidate = lines.find(l => l.length > 1);
      if (candidate) bestText = candidate;
    }

    return bestText;
  }

  // ── FIX (Issue 2): Replaced isEmojiOnly with isMeaninglessContent ─────────
  // Original isEmojiOnly only filtered pure-emoji strings, leaving symbol-only
  // strings like "?!?", "...", "!!!", "@@@" to pass through unchecked.
  // New function handles three additional cases:
  //   a) After removing emoji, the remainder contains only punctuation/symbols
  //      (uses Unicode property escapes \p{P} and \p{S}).
  //   b) A repeating single character ≥ 3 times: "!!!!", "....".
  //   c) No Unicode letter or digit anywhere in the text at all.
  // NOTE: pure emoji comments (e.g. "😂😂😂") are intentionally kept — they
  // represent genuine reactions and should NOT be filtered. The function returns
  // false for pure-emoji input so they survive into the final comment list.
  function isMeaninglessContent(text) {
    if (!text || text.length < 2) return true;

    // Strip all emoji codepoints from the text
    const withoutEmoji = text
      .replace(
        /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F300}-\u{1F9FF}]/gu,
        ""
      )
      .replace(/\s+/g, "")
      .trim();

    // Pure emoji comment → valid reaction, do NOT filter
    if (withoutEmoji.length === 0) return true;

    // After removing emoji, only punctuation/symbols remain → meaningless
    // \p{P} = punctuation categories, \p{S} = symbol categories (Unicode)
    if (/^[\p{P}\p{S}\p{M}\p{C}]+$/u.test(withoutEmoji)) return true;

    // Repeating single character ≥ 3 times: "!!!!", "....", "????", "@@@@"
    if (/^(.)\1{2,}$/.test(withoutEmoji)) return true;

    // Must contain at least one Unicode letter or digit
    if (!/[\p{L}\p{N}]/u.test(text)) return true;

    return false;
  }

  function cleanComment(text) {
    if (!text || text.length < 2) return null;
    text = text.replace(/\b\d+[smhdwy]\b/gi, "").trim();
    text = text.replace(
      /\b(Like|Reply|Share|See more|See less|See translation|Edited|Follow|Unfollow|Author)\b/gi,
      ""
    ).trim();
    text = text.replace(/\d+\s+(comments|shares|reactions|likes)/gi, "").trim();
    text = text.replace(/^[\u00b7\u2022\-\s·]+/, "").trim();
    text = text.replace(/[\u00A0\u200B\u200C\u200D\uFEFF]/g, " ")
               .replace(/\s+/g, " ").trim();

    if (!text || text.length < 2) return null;
    if (UI_NOISE.has(text)) return null;
    if (REACTION_WORDS.has(text)) return null;
    if (/^@\w+$/.test(text)) return null;
    if (/^#\w+(\s+#\w+)*$/.test(text)) return null;

    // FIX (Issue 2): replaced isEmojiOnly() with isMeaninglessContent().
    // Previously only pure-emoji strings were filtered; now symbol-only strings
    // like "?!?", "...", "!!!!" are also rejected while pure emoji are kept.
    if (isMeaninglessContent(text)) return null;

    // FIX (Issue 1): reject "Name1mLikeReply" concatenation artifacts that
    // survive the extraction stage. These occur when Facebook's header row
    // collapses into a single string without whitespace separators.
    if (/\d+[smhdwy](Like|Reply|Share|Comment)/i.test(text)) return null;

    return text;
  }

  const processedFingerprints = new Set();

  // ── FIX (Issue 3 + 4): Improved fingerprint ───────────────────────────────
  // Original: used article.innerText.slice(0,80) which returns "" for
  // emoji-only comments (because innerText skips <img alt="😂">), causing
  // ALL emoji-only comments from different authors to share the fingerprint ""
  // and be deduplicated down to a single slot.
  // Fix: build the fingerprint from author name + getTextWithEmoji content.
  // FIX (Issue 4): return null for skeleton/unhydrated articles (both parts
  // empty) so they are skipped without being permanently marked as seen.
  // Once the article hydrates, it will have a real fingerprint and be processed.
  function fingerprintArticle(article) {
    const authorEl = article.querySelector("strong, h3, h4");
    const authorPart = authorEl?.innerText?.trim().slice(0, 30) || "";
    // FIX (Issue 3): use emoji-aware extractor for the content portion
    const contentPart = getTextWithEmoji(article).trim().slice(0, 60);
    // FIX (Issue 4): signal skeleton article — do not mark as seen yet
    if (authorPart.length < 1 && contentPart.length < 1) return null;
    return (authorPart + "|" + contentPart).replace(/\s+/g, " ");
  }

  // ── FIX (Issue 4): Adaptive per-article hydration wait ───────────────────
  // Original: fixed 120ms sleep after scrollIntoView, which is insufficient
  // for Facebook's intersection-observer-triggered lazy hydration on slow
  // connections. The browser needs time to: fire the observer, request the
  // comment body, receive it, and insert it into the DOM.
  // Fix: poll until the article has extractable content (at least one letter
  // or digit), up to maxMs, so we don't process skeleton nodes.
  async function waitForArticleContent(article, maxMs = 800) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const text = getTextWithEmoji(article).trim();
      // Consider hydrated when at least one letter/digit is present
      if (/[\p{L}\p{N}]/u.test(text)) return;
      await new Promise(r => setTimeout(r, 80));
    }
    // Timed out — proceed anyway; cleanComment will filter skeleton content
  }

  // ── FIX (Issue 4): Content-settle detector for scroll rounds ─────────────
  // Original: fixed 1.5–2s wait after scrolling, then a count-based loop
  // that broke on the first article-count increase (even if DOM insertion
  // was still in progress). On slow connections this left partially rendered
  // comment batches unprocessed.
  // Fix: poll article count and consider it "settled" only after three
  // consecutive polls with no change, up to maxWaitMs total.
  async function waitForContentSettle(container, previousCount, maxWaitMs = 8000) {
    const start = Date.now();
    let stableCount = 0;
    let lastCount = previousCount;
    while (Date.now() - start < maxWaitMs) {
      await new Promise(r => setTimeout(r, 500));
      const root = container?.querySelectorAll ? container : document;
      const current = root.querySelectorAll("[role='article']").length;
      if (current === lastCount) {
        stableCount++;
        if (stableCount >= 3) break; // stable for ~1.5s → insertion complete
      } else {
        stableCount = 0;
        lastCount = current;
      }
    }
  }

  async function extractFromContainer(container) {
    const root = container || document;
    const articles = Array.from(root.querySelectorAll("[role='article']"));
    let newCount = 0;

    for (const article of articles) {
      if (comments.length >= maxComments) break;

      // FIX (Issue 4): fingerprintArticle returns null for skeleton articles.
      // Skip without adding to processedFingerprints so the hydrated version
      // of the same article gets a real fingerprint and is processed later.
      const fp = fingerprintArticle(article);
      if (fp === null) continue;
      if (processedFingerprints.has(fp)) continue;

      if (article.querySelector("[role='textbox']")) continue;
      if (article.querySelector("[data-testid*='ad']")) continue;

      article.scrollIntoView({ block: "center" });
      // FIX (Issue 4): replaced fixed 120ms with adaptive hydration wait
      await waitForArticleContent(article);

      const authorName = getAuthorName(article);
      const rawText = extractCommentText(article, authorName);

      if (!rawText || rawText.length < 2) {
        console.log(`[SKIP] No text — author: ${authorName}`);
        // FIX (Issue 4): only mark as seen after we confirm we got no text
        // AND the article is actually hydrated (has an author). If authorName
        // is also null, it is likely still a skeleton — do not mark it.
        if (authorName) processedFingerprints.add(fp);
        continue;
      }

      const cleaned = cleanComment(rawText);
      if (!cleaned) {
        console.log(`[DROPPED] cleanComment: ${JSON.stringify(rawText.slice(0, 60))}`);
        processedFingerprints.add(fp);
        continue;
      }

      const key = cleaned.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
      if (seen.has(key)) {
        processedFingerprints.add(fp);
        continue;
      }
      seen.add(key);

      comments.push(cleaned);
      processedFingerprints.add(fp);
      newCount++;
    }
    return newCount;
  }

  function scrollContainer(container) {
    if (!container || container === document) {
      window.scrollBy({ top: 400, behavior: "smooth" });
      return;
    }
    container.scrollTop += 400;
    container.querySelectorAll("[role='complementary']").forEach(el => {
      if (el.scrollHeight > el.clientHeight) el.scrollTop += 400;
    });
    container.querySelectorAll("div").forEach(div => {
      if (div.scrollHeight > div.clientHeight + 100 &&
          div.querySelectorAll("[role='article']").length > 0) {
        div.scrollTop += 400;
      }
    });
  }

  // ── FIX (Issue 4): Click ALL visible "View more" buttons per round ────────
  // Original: used break after the first matching button click per label, so
  // only one "View more comments" button was clicked per round. Facebook posts
  // with hundreds of comments often render multiple stacked load-more buttons
  // (one per visible thread boundary). Clicking only the first left subsequent
  // blocks unreachable until a future round happened to scroll to them.
  // Fix: collect ALL matching buttons across all labels, click each one with
  // a short inter-click delay, then do a single settle wait at the end.
  async function clickViewMore(container) {
    const root = container || document;
    const labels = [
      "View more comments", "View previous comments",
      "See more comments", "Load more comments",
      "Xem thêm bình luận", "Ver más comentarios"
    ];
    const clicked = [];
    for (const label of labels) {
      const buttons = Array.from(root.querySelectorAll("[role='button']"));
      // FIX (Issue 4): find ALL matching buttons for this label, not just the first
      const matching = buttons.filter(b =>
        b.innerText?.trim().includes(label) &&
        b.getBoundingClientRect().height > 0 &&
        !clicked.includes(b) // avoid double-clicking the same button
      );
      for (const btn of matching) {
        btn.click();
        clicked.push(btn);
        await new Promise(r => setTimeout(r, 1200)); // brief gap between clicks
      }
    }
    if (clicked.length > 0) {
      // FIX (Issue 4): settle wait after all clicks before re-extracting
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  function isReelPage() {
    return window.location.href.includes("/reel/") ||
           window.location.href.includes("/watch/");
  }

  async function scrollReelPanel(panel) {
    if (!panel) return;
    panel.scrollTop += 300 + Math.random() * 200;
    await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
  }

  async function openReelComments() {
    const existing = findCommentContainer();
    if (existing && existing !== document &&
        existing.querySelectorAll("[role='article']").length > 1) {
      return existing;
    }
    const allButtons = document.querySelectorAll("[role='button']");
    for (const btn of allButtons) {
      const ariaLabel = (btn.getAttribute("aria-label") || "").toLowerCase();
      const text = (btn.innerText?.trim() || "").toLowerCase();
      if (ariaLabel.includes("comment") || text === "comment" || text === "comments") {
        btn.click();
        await new Promise(r => setTimeout(r, 4000));
        break;
      }
    }
    return findCommentContainer();
  }

async function switchToAllComments(container) {
  const root = container || document;
  let sortBtn = null;
  for (const btn of root.querySelectorAll("[role='button']")) {
    const text = btn.innerText?.trim() || "";
    if (/most\s*relevant|top\s*comments|pinakaangkop|newest|pinakabago/i.test(text)) {
      sortBtn = btn;
      break;
    }
  }
  if (!sortBtn) {
    console.log("[MoodSentinel] Sort button not found");
    return false;
  }

  if (/all\s*comments/i.test(sortBtn.innerText?.trim())) {
    console.log("[MoodSentinel] Already on All Comments");
    return true;
  }

  console.log("[MoodSentinel] Clicking sort:", sortBtn.innerText.trim());
  sortBtn.click();
  await new Promise(r => setTimeout(r, 2500));

  // ── NO visibility filter — Facebook renders these off-screen ──
  const menuItems = Array.from(
    document.querySelectorAll("[role='menuitem'], [role='option']")
  );

  console.log("[MoodSentinel] Menu items:", menuItems.map(i => i.innerText?.trim()));

  const priority = [
    { regex: /all\s*comments|lahat|tất\s*cả/i,         label: "All Comments" },
    { regex: /newest|pinakabago|mới\s*nhất|recientes/i, label: "Newest"       },
  ];

  for (const { regex, label } of priority) {
    const match = menuItems.find(item => regex.test(item.innerText?.trim() || ""));
    if (match) {
      console.log(`[MoodSentinel] Clicking: ${label}`);
      match.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      match.dispatchEvent(new MouseEvent("mouseup",   { bubbles: true }));
      match.click();
      await new Promise(r => setTimeout(r, 4000));

      for (const btn of root.querySelectorAll("[role='button']")) {
        const t = btn.innerText?.trim() || "";
        if (/most\s*relevant|all\s*comments|newest|pinakaangkop/i.test(t)) {
          console.log("[MoodSentinel] Sort label after switch:", t);
          break;
        }
      }
      return true;
    }
  }

  console.warn("[MoodSentinel] No suitable sort option found");
  return false;
}

  async function submitToBackend(jobId, comments, url) {
    try {
      const res = await fetch(`${apiBase}/api/extension/submit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "ngrok-skip-browser-warning": "true"
        },
        body: JSON.stringify({ job_id: jobId, comments, post_url: url })
      });
      if (res.ok) {
        console.log("[MoodSentinel] Submitted", comments.length, "comments to backend");
      } else {
        console.error("[MoodSentinel] Submit failed:", res.status);
      }
    } catch (err) {
      console.error("[MoodSentinel] Direct submit error:", err.message);
      chrome.runtime.sendMessage({ type: "COMMENTS_SCRAPED", jobId, comments, url });
    }
  }

  async function runScraper() {
    const reel = isReelPage();
    console.log("[MoodSentinel] Page type:", reel ? "REEL/WATCH" : "POST");

    const container = reel ? await openReelComments() : findCommentContainer();

    if (!container) {
      console.warn("[MoodSentinel] No container found — aborting");
      await submitToBackend(jobId, comments, window.location.href);
      return;
    }

    if (!reel) {
      await switchToAllComments(container);
      await new Promise(r => setTimeout(r, 2000));
    }

    console.log("[MoodSentinel] Warm-up pass...");
    const initialArticles = container === document
      ? document.querySelectorAll("[role='article']")
      : container.querySelectorAll("[role='article']");

    for (const article of initialArticles) {
      article.scrollIntoView({ block: "center" });
      await new Promise(r => setTimeout(r, 60));
    }
    await new Promise(r => setTimeout(r, 800));
    await extractFromContainer(container);
    console.log("[MoodSentinel] Warm-up done:", comments.length, "comments");

    let noNewRounds = 0;
    const maxRounds = 80;
    const maxNoNew = reel ? 10 : 8;

    for (let round = 0; round < maxRounds; round++) {
      if (comments.length >= maxComments) break;

      scrollContainer(reel ? container : container === document ? null : container);

      // FIX (Issue 4): replaced the original fixed 1.5–2s wait + count-polling
      // loop with waitForContentSettle(), which waits until article count has
      // been stable for three consecutive polls (up to 8s). This prevents
      // processing partially rendered comment batches on slow connections.
      const beforeCount = (container?.querySelectorAll
        ? container
        : document
      ).querySelectorAll("[role='article']").length;

      await waitForContentSettle(container, beforeCount);

      // clickViewMore now clicks ALL visible buttons, not just the first
      await clickViewMore(container);

      const newCount = await extractFromContainer(container);
      const totalArticles = (container?.querySelectorAll
        ? container
        : document
      ).querySelectorAll("[role='article']").length;

      console.log(
        `[MoodSentinel] Round ${round + 1}: +${newCount}` +
        ` | total: ${comments.length} | articles: ${totalArticles}` +
        ` | fingerprints: ${processedFingerprints.size}`
      );

      if (newCount === 0) {
        noNewRounds++;
        if (noNewRounds >= maxNoNew) {
          console.log("[MoodSentinel] Stagnation limit reached — stopping");
          break;
        }
      } else {
        noNewRounds = 0;
      }

      if (round % 10 === 9) {
        await new Promise(r => setTimeout(r, 2000 + Math.random() * 1000));
      }
    }

    console.log("[MoodSentinel] Scrape complete:", comments.length, "comments");
    await submitToBackend(jobId, comments, window.location.href);

    try {
      chrome.runtime.sendMessage({
        type: "COMMENTS_SCRAPED",
        jobId,
        comments,
        url: window.location.href
      });
    } catch (_) {}
  }

  runScraper();
}

// ── Handle scraped comments — fallback path ───────────────────────────────────
async function handleScrapedComments(jobId, comments, url) {
  console.log("[MoodSentinel] Message fallback: received", comments.length, "comments for job", jobId);
  updateBadge(String(comments.length), "#4CAF50");
  try {
    const res = await fetch(`${API_BASE}/api/extension/submit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true"
      },
      body: JSON.stringify({ job_id: jobId, comments, post_url: url })
    });
    if (res.ok) {
      console.log("[MoodSentinel] Fallback submit succeeded.");
      chrome.runtime.sendMessage({ type: "JOB_COMPLETE", jobId, commentCount: comments.length }).catch(() => {});
    } else {
      console.error("[MoodSentinel] Fallback submit failed:", res.status);
    }
  } catch (err) {
    console.error("[MoodSentinel] Fallback submit error:", err.message);
  }
}

async function markJobFailed(jobId, reason) {
  try {
    await fetch(`${API_BASE}/api/extension/fail`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true"
      },
      body: JSON.stringify({ job_id: jobId, reason })
    });
  } catch (_) {}
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForTabLoad(tabId, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Tab load timeout")), timeout);
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function waitForJobComplete(jobId, timeout) {
  const start = Date.now();
  console.log("[MoodSentinel] Polling for job completion:", jobId);
  while (Date.now() - start < timeout) {
    await sleep(5000);
    try {
      const res = await fetch(`${API_BASE}/api/extension/status/${jobId}`, {
        headers: { "ngrok-skip-browser-warning": "true" }
      });
      if (res.ok) {
        const data = await res.json();
        console.log("[MoodSentinel] Job status:", data.status, "| comments:", data.comment_count);
        if (data.status === "complete" || data.status === "failed") return;
      }
    } catch (err) {
      console.warn("[MoodSentinel] Status poll error:", err.message);
    }
  }
  throw new Error("Job timeout after " + (timeout / 1000) + "s");
}