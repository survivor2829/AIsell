// Keyword acquisition per platform: where to search, which of the page's own responses
// carry videos and comments, and how to read them. Shapes were confirmed on Kuaishou's
// web site on 2026-10-26 (search: /rest/v/search/feed, comments: GraphQL commentListQuery).
const fail = (code, message) => Object.assign(new Error(message), { code });
const ID = /^[A-Za-z0-9_-]{4,64}$/;
const text = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const iso = (ms) => { const n = Number(ms); return Number.isFinite(n) && n > 0 ? new Date(n < 1e12 ? n * 1000 : n).toISOString() : ""; };
const count = (value) => { const n = Number(String(value ?? "").replace(/[^\d.]/g, "")); return Number.isFinite(n) ? n : 0; };

const DRIVERS = {
  kuaishou: {
    name: "快手", host: "kuaishou.com", available: true,
    searchUrl: (keyword) => `https://www.kuaishou.com/search/video?searchKey=${encodeURIComponent(keyword)}`,
    videoUrl: (id) => `https://www.kuaishou.com/short-video/${id}`,
    loggedOutText: /登录即可享受|扫码登录/,
    isSearch: (url) => /www\.kuaishou\.com\/rest\/v\/search\/feed/.test(url),
    isComments: (url, operation) => /www\.kuaishou\.com\/graphql/.test(url) && operation === "commentListQuery",
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
    }
  },
  // Douyin's web search shows a captcha that rejects any program-driven browser, and the
  // app does not disguise itself to get past platform checks, so Douyin is listed but off.
  douyin: { name: "抖音", available: false, unavailable: "抖音网页版搜索会拦截软件控制的浏览器（弹出验证码且无法通过），暂不支持；快手可以正常使用。" }
};

function acquireDriverFor(platform) {
  const driver = DRIVERS[platform];
  if (!driver) throw fail("ACQUIRE_PLATFORM_INVALID", "暂不支持这个平台。");
  if (!driver.available) throw fail("ACQUIRE_PLATFORM_UNAVAILABLE", driver.unavailable);
  return driver;
}

// Purchase intent in a comment. The built-in phrases come from the earlier keyword module;
// the user's own words are added on top.
const BUILT_IN = [
  ["询价", /多少钱|价格|什么价|怎么卖|报价|价位|贵不贵|便宜/],
  ["想买", /怎么买|哪里买|哪里下单|想买|求购|有货吗|能发货|如何购买|链接|下单/],
  ["要联系", /怎么联系|联系方式|电话|微信|加你|私信|地址在哪|门店在哪|想了解|了解一下/],
  ["问效果", /好用吗|效果怎么样|有买过|用过的|靠谱吗|值得买|推荐吗/]
];
function intentOf(comment, extraWords = []) {
  const value = String(comment || "");
  const signals = BUILT_IN.filter(([, pattern]) => pattern.test(value)).map(([label]) => label);
  for (const word of extraWords) if (word && value.includes(word)) signals.push(`含「${word}」`);
  return [...new Set(signals)];
}

module.exports = { DRIVERS, acquireDriverFor, intentOf };
