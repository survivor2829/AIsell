// Keyword acquisition per platform: where to search, which of the page's own responses
// carry videos and comments, and how to read them. Shapes were confirmed on Kuaishou's
// web site on 2026-10-26 (search: /rest/v/search/feed, comments: GraphQL commentListQuery).
const fail = (code, message) => Object.assign(new Error(message), { code });
const ID = /^[A-Za-z0-9_-]{4,64}$/;
const text = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const iso = (ms) => { const n = Number(ms); return Number.isFinite(n) && n > 0 ? new Date(n < 1e12 ? n * 1000 : n).toISOString() : ""; };
const count = (value) => { const n = Number(String(value ?? "").replace(/[^\d.]/g, "")); return Number.isFinite(n) ? n : 0; };
// Douyin's public user id is longer than other platforms' ids, and it is what its profile links use.
const DOUYIN_USER = /^[A-Za-z0-9_-]{4,128}$/;
const douyinUser = (user) => String(user?.sec_uid || "");
const douyinWords = (comment) => String(comment || "").replace(/\[[^\]]*\]/g, "").replace(/\s+/g, "");

const DRIVERS = {
  kuaishou: {
    name: "快手", host: "kuaishou.com", available: true,
    searchUrl: (keyword) => `https://www.kuaishou.com/search/video?searchKey=${encodeURIComponent(keyword)}`,
    videoUrl: (id) => `https://www.kuaishou.com/short-video/${id}`,
    loggedOutText: /登录即可享受|扫码登录/,
    isSearch: (url) => /www\.kuaishou\.com\/rest\/v\/search\/feed/.test(url),
    isComments: (url, operation) => /www\.kuaishou\.com\/graphql/.test(url) && operation === "commentListQuery",
    commentItems: ".comment-list-item",
    commentVideoId: (_url, variables) => String(variables?.photoId || ""),
    link: /^https:\/\/www\.kuaishou\.com\/(short-video|profile)\/[A-Za-z0-9_-]+$/,
    profileUrl: (userId) => `https://www.kuaishou.com/profile/${userId}`,
    parseSearch(json) {
      const videos = (Array.isArray(json?.feeds) ? json.feeds : []).flatMap((feed) => {
        const photo = feed?.photo, author = feed?.author;
        if (!ID.test(String(photo?.id || ""))) return [];
        return [{ id: String(photo.id), title: text(photo.caption, 200), authorId: String(author?.id || ""), authorName: text(author?.name, 60),
          likes: count(photo.likeCount), comments: count(photo.commentCount), publishedAt: iso(photo.timestamp) }];
      });
      return { videos, more: Boolean(json?.pcursor) && json.pcursor !== "no_more" };
    },
    parseComments(json) {
      const list = json?.data?.visionCommentList;
      const items = Array.isArray(list?.rootCommentsV2) ? list.rootCommentsV2 : Array.isArray(list?.rootComments) ? list.rootComments : [];
      const comments = items.flatMap((item) => {
        const id = String(item?.commentId || ""), userId = String(item?.authorId || "");
        if (!/^\d{4,32}$/.test(id) || !ID.test(userId) || !text(item?.content, 500)) return [];
        return [{ id, userId, userName: text(item.authorName, 60), text: text(item.content, 500), at: iso(item.timestamp), region: "" }];
      });
      const cursor = list?.pcursorV2 ?? list?.pcursor;
      return { comments, more: Boolean(cursor) && cursor !== "no_more" };
    },
    // Actions, confirmed on 2026-10-26: liking a comment answers GraphQL visionLikeComment
    // {result: 1} and marks the icon .liked (a second click would unlike it); following answers
    // /rest/v/relation/follow {result: 1, followStatus: 1} and the button reads 已关注. The web
    // site has no reply-to-comment, so replies are not offered here. Commenting under peer videos
    // was removed after the platform hid every such comment as advertising (2026-10-26).
    actions: {
      like: true, follow: true,
      profileUrl: (userId) => `https://www.kuaishou.com/profile/${userId}`,
      // Compared without any spaces: the page shows 「🌸 小花🌷 」 where the data says 「🌸小花🌷」.
      commentItem: (userName, content) => `[...document.querySelectorAll(".comment-list-item")].find((el) => {
        const name = (el.querySelector(".author-name")?.textContent || "").replace(/\\s+/g, "");
        const said = (el.querySelector(".comment-item-content")?.textContent || "").replace(/\\s+/g, "");
        return name === ${JSON.stringify(String(userName).replace(/\s+/g, ""))} && said.slice(0, 60) === ${JSON.stringify(String(content).replace(/\s+/g, "").slice(0, 60))}; })`,
      likeIcon: ".comment-item-likeicon", likedClass: "liked",
      followButton: ".follow-btn", followed: /已关注|互相关注/,
      isLike: (url, operation) => /www\.kuaishou\.com\/graphql/.test(url) && operation === "visionLikeComment",
      isFollow: (url) => /www\.kuaishou\.com\/rest\/v\/relation\/follow/.test(url),
      // { ok, message } from an action's response; anything but result 1 is a refusal.
      outcome(json) {
        const body = json?.data ? Object.values(json.data)[0] : json;
        const result = Number(body?.result ?? json?.result);
        const message = text(body?.error_msg || json?.error_msg || json?.errors?.[0]?.message || "", 120);
        // No result and no error says nothing either way.
        if (!Number.isFinite(result) && !message && !json?.errors?.length) return { ok: null, message: "" };
        return { ok: result === 1 && !json?.errors?.length, message };
      }
    }
  },
  // Shapes confirmed on 2026-11-01 with a logged-in test account: search answers /aweme/v1/web/search/item/
  // (data[].aweme_info), comments /aweme/v1/web/comment/list/ (aweme_id in the query, cursor paging), and
  // no verification appeared at that low pace. The app still leaves any verification to the user.
  douyin: {
    name: "抖音", host: "douyin.com", available: true,
    searchUrl: (keyword) => `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=video`,
    videoUrl: (id) => `https://www.douyin.com/video/${id}`,
    profileUrl: (userId) => `https://www.douyin.com/user/${userId}`,
    link: /^https:\/\/www\.douyin\.com\/(video|user)\/[A-Za-z0-9_-]+$/,
    loggedOutText: /扫码登录|登录后免费|验证码登录|手机号登录/,
    isSearch: (url) => /douyin\.com\/aweme\/v1\/web\/search\/item\/?(\?|$)/.test(url),
    isComments: (url) => /douyin\.com\/aweme\/v1\/web\/comment\/list\/?(\?|$)/.test(url),
    commentItems: '[data-e2e="comment-item"]',
    commentVideoId: (url) => { try { return String(new URL(url).searchParams.get("aweme_id") || ""); } catch { return ""; } },
    parseSearch(json) {
      const videos = (Array.isArray(json?.data) ? json.data : []).flatMap((entry) => {
        const aweme = entry?.aweme_info, author = aweme?.author;
        if (!/^\d{4,32}$/.test(String(aweme?.aweme_id || ""))) return [];
        return [{ id: String(aweme.aweme_id), title: text(aweme.desc, 200), authorId: douyinUser(author), authorName: text(author?.nickname, 60),
          likes: count(aweme.statistics?.digg_count), comments: count(aweme.statistics?.comment_count), publishedAt: iso(aweme.create_time) }];
      });
      const refused = Number(json?.status_code || 0) !== 0 || /verify/i.test(String(json?.search_nil_info?.search_nil_type || ""));
      return { videos, more: Number(json?.has_more) === 1, refused };
    },
    parseComments(json) {
      const raw = Array.isArray(json?.comments) ? json.comments : [];
      const comments = raw.flatMap((item) => {
        const id = String(item?.cid || ""), userId = douyinUser(item?.user);
        if (!/^\d{4,32}$/.test(id) || !DOUYIN_USER.test(userId) || !text(item?.text, 500)) return [];
        return [{ id, userId, userName: text(item.user?.nickname, 60), text: text(item.text, 500), at: iso(item.create_time), region: text(item.ip_label, 20), liked: Number(item.user_digged) === 1 }];
      });
      return { comments, more: Number(json?.has_more) === 1, refused: Number(json?.status_code || 0) !== 0, unreadable: raw.length > 0 && !comments.length };
    },
    // Actions, confirmed on 2026-11-01: a like answers /aweme/v1/web/comment/digg {status_code: 0} and turns
    // the heart #FE2C55 (a second click would take it back); a follow answers /aweme/v1/web/commit/follow/user/
    // {status_code: 0, follow_status: 1} and the button reads 已关注. The page's class names are generated, so
    // the heart is found by its place in the comment's stats row.
    actions: {
      like: true, follow: true,
      profileUrl: (userId) => `https://www.douyin.com/user/${userId}`,
      // Emoji show as pictures on the page, so they are left out of the comparison. A comment with no
      // words left cannot be told apart from the person's other comments and is reported as not found.
      commentItem: (userName, content) => !douyinWords(content) ? "undefined" : `[...document.querySelectorAll('[data-e2e="comment-item"]')].find((el) => {
        const name = (el.querySelector(".comment-item-info-wrap a")?.textContent || "").replace(/\\s+/g, "");
        return name === ${JSON.stringify(String(userName).replace(/\s+/g, ""))} && (el.innerText || el.textContent || "").replace(/\\s+/g, "").includes(${JSON.stringify(douyinWords(content).slice(0, 60))}); })`,
      likeIcon: ".comment-item-stats-container > div:first-child > p:first-child",
      likedExpression: (icon) => `(() => { const path = (${icon})?.querySelector("svg path"); return Boolean(path) && /254,\\s*44,\\s*85/.test(getComputedStyle(path).fill); })()`,
      followButton: 'button[data-e2e="user-info-follow-btn"]', followed: /已关注|互相关注|相互关注|已请求/,
      // 回关 is how the button reads when the person already follows this account.
      followable: /^(\+\s*)?(关注|回关)$/,
      // The request names the comment, so an answer about another comment is not credited to this one.
      likeAnswer: (url, commentId) => { try { return new URL(url).searchParams.get("cid") === String(commentId); } catch { return false; } },
      isLike: (url) => /douyin\.com\/aweme\/v1\/web\/comment\/digg\/?(\?|$)/.test(url),
      isFollow: (url) => /douyin\.com\/aweme\/v1\/web\/commit\/follow\/user\/?(\?|$)/.test(url),
      outcome(json) {
        const code = Number(json?.status_code), message = text(json?.status_msg, 120);
        if (!Number.isFinite(code)) return { ok: null, message: "" };
        if (code !== 0) return { ok: false, message };
        // A follow answer that still says "not following" says nothing either way.
        return "follow_status" in json && !Number(json.follow_status) ? { ok: null, message: "" } : { ok: true, message };
      }
    }
  }

};

function acquireDriverFor(platform) {
  const driver = DRIVERS[platform];
  if (!driver) throw fail("ACQUIRE_PLATFORM_INVALID", "暂不支持这个平台。");
  if (!driver.available) throw fail("ACQUIRE_PLATFORM_UNAVAILABLE", driver.unavailable);
  return driver;
}

// Purchase intent in a comment. The built-in phrases come from the earlier keyword module;
// the user's own words are added on top. Only asking forms count: a review like
// 「价格也能接受」 or 「接的电话」 mentions price or a phone without asking for anything.
const BUILT_IN = [
  ["询价", /多少钱|什么价|啥价|怎么卖|报价|价位|贵不贵|便宜吗|能便宜|价格(是)?(多少|怎么样|如何|呢|[?？])/],
  ["想买", /怎么买|哪里买|哪里下单|想买|求购|有货吗|能发货|如何购买|求链接|链接(呢|在哪|[?？])|下单/],
  ["要联系", /怎么联系|联系方式|(留|给|发|要)个?(电话|微信)|(电话|微信)(多少|号)|加你|私信我?|地址在哪|门店在哪|想了解|了解一下/],
  ["问效果", /好用吗|效果怎么样|效果如何|有买过|有用过|用过的(说|来|吗)|靠谱吗|值得买|推荐吗|耐用吗/]
];
function intentOf(comment, extraWords = []) {
  const value = String(comment || "");
  const signals = BUILT_IN.filter(([, pattern]) => pattern.test(value)).map(([label]) => label);
  for (const word of extraWords) if (word && value.includes(word)) signals.push(`含「${word}」`);
  return [...new Set(signals)];
}

// A platform telling the account to slow down; the account then rests until tomorrow.
// Only wording about pace: 「评论功能已限制」 or 「已达关注上限」 are refusals, not a reason to rest.
const TOO_FREQUENT = /频繁|太快|操作过于|稍后再试/;

module.exports = { DRIVERS, acquireDriverFor, intentOf, TOO_FREQUENT };
