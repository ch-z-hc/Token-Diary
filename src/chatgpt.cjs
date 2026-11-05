// Parse account exports as untrusted data; never extract attachments or execute content.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { clean } = require("./scanner.cjs");
const MAX_JSON = 64 * 1024 * 1024;
const MAX_TOTAL = 256 * 1024 * 1024;
const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);
const conversationFile = (name) =>
  /(?:^|\/)conversations(?:-\d+)?\.json$/i.test(name);
function zipParts(file) {
  if (fs.statSync(file).size > 512 * 1024 * 1024)
    throw new Error("chatgpt-zip-too-large");
  const data = fs.readFileSync(file);
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (
      data.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + data.readUInt16LE(i + 20) === data.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0 || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6))
    throw new Error("unsupported-chatgpt-zip");
  const count = data.readUInt16LE(end + 10),
    size = data.readUInt32LE(end + 12),
    start = data.readUInt32LE(end + 16);
  if (count === 65535 || start + size > end)
    throw new Error("unsupported-chatgpt-zip");
  const parts = [];
  let offset = start,
    total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > start + size || data.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("invalid-chatgpt-zip");
    const flags = data.readUInt16LE(offset + 8),
      method = data.readUInt16LE(offset + 10),
      crc = data.readUInt32LE(offset + 16);
    const packed = data.readUInt32LE(offset + 20),
      unpacked = data.readUInt32LE(offset + 24),
      len = data.readUInt16LE(offset + 28),
      extra = data.readUInt16LE(offset + 30),
      comment = data.readUInt16LE(offset + 32),
      local = data.readUInt32LE(offset + 42);
    const next = offset + 46 + len + extra + comment;
    if (next > start + size) throw new Error("invalid-chatgpt-zip");
    const name = data.subarray(offset + 46, offset + 46 + len).toString("utf8");
    offset = next;
    if (!conversationFile(name)) continue;
    total += unpacked;
    if (
      flags & 1 ||
      ![0, 8].includes(method) ||
      unpacked > MAX_JSON ||
      total > MAX_TOTAL ||
      local + 30 > start ||
      data.readUInt32LE(local) !== 0x04034b50
    )
      throw new Error("unsupported-chatgpt-zip-member");
    const body =
      local +
      30 +
      data.readUInt16LE(local + 26) +
      data.readUInt16LE(local + 28);
    if (body + packed > start) throw new Error("invalid-chatgpt-zip-member");
    const raw = data.subarray(body, body + packed);
    const bytes =
      method === 0
        ? raw
        : zlib.inflateRawSync(raw, { maxOutputLength: MAX_JSON });
    if (bytes.length !== unpacked || zlib.crc32(bytes) !== crc)
      throw new Error("invalid-chatgpt-zip-checksum");
    parts.push(bytes.toString("utf8"));
  }
  if (!parts.length) throw new Error("no-chatgpt-conversations");
  return parts;
}
function readParts(file) {
  const stat = fs.statSync(file);
  if (stat.isDirectory()) {
    const files = fs.readdirSync(file).filter(conversationFile).sort();
    if (!files.length) throw new Error("no-chatgpt-conversations");
    let total = 0;
    return files.map((name) => {
      const size = fs.statSync(path.join(file, name)).size;
      total += size;
      if (size > MAX_JSON || total > MAX_TOTAL)
        throw new Error("chatgpt-json-too-large");
      return fs.readFileSync(path.join(file, name), "utf8");
    });
  }
  if (/\.zip$/i.test(file)) return zipParts(file);
  if (stat.size > MAX_JSON) throw new Error("chatgpt-json-too-large");
  return [fs.readFileSync(file, "utf8")];
}
function branch(conversation) {
  const mapping = conversation.mapping;
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping))
    throw new Error("invalid-chatgpt-mapping");
  let cursor = conversation.current_node;
  if (!cursor) {
    const parents = new Set(
      Object.values(mapping)
        .map((n) => n?.parent)
        .filter(Boolean),
    );
    const leaves = Object.keys(mapping).filter((id) => !parents.has(id));
    if (leaves.length !== 1) throw new Error("ambiguous-chatgpt-branch");
    cursor = leaves[0];
  }
  const nodes = [],
    seen = new Set();
  while (cursor) {
    if (
      seen.has(cursor) ||
      !Object.hasOwn(mapping, cursor) ||
      !mapping[cursor] ||
      typeof mapping[cursor] !== "object"
    )
      throw new Error("invalid-chatgpt-branch");
    seen.add(cursor);
    const node = mapping[cursor];
    nodes.push(node);
    cursor = node.parent;
  }
  return nodes.reverse();
}
function parse(
  documents,
  { timezone = "Asia/Shanghai", captureText = false } = {},
) {
  if (!Array.isArray(documents)) throw new Error("invalid-chatgpt-export");
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const conversations = new Map(),
    events = [],
    groups = new Map(),
    errors = [],
    seen = new Set();
  for (const document of documents) {
    const rows =
      typeof document === "string"
        ? JSON.parse(document.replace(/^\uFEFF/, ""))
        : document;
    if (!Array.isArray(rows)) throw new Error("invalid-chatgpt-export");
    for (const c of rows) {
      const id = c?.conversation_id || c?.id;
      if (typeof id !== "string" || !id || id.length > 500)
        throw new Error("invalid-chatgpt-conversation");
      const old = conversations.get(id);
      if (!old || Number(c.update_time || 0) >= Number(old.update_time || 0))
        conversations.set(id, c);
    }
  }
  for (const [id, c] of conversations) {
    let nodes;
    try {
      nodes = branch(c);
    } catch (e) {
      errors.push({ agent: "ChatGPT", kind: e.message });
      continue;
    }
    for (const node of nodes) {
      const m = node.message,
        role = m?.author?.role,
        content = m?.content,
        metadata = m?.metadata || {};
      if (
        !["user", "assistant"].includes(role) ||
        !["text", "multimodal_text"].includes(content?.content_type) ||
        metadata.is_visually_hidden_from_conversation ||
        metadata.is_hidden ||
        (m.recipient && m.recipient !== "all") ||
        (m.channel && m.channel !== "final")
      )
        continue;
      const message = m.id || node.id;
      if (
        typeof message !== "string" ||
        !message ||
        message.length > 500 ||
        typeof m.create_time !== "number" ||
        !Number.isFinite(m.create_time)
      ) {
        errors.push({ agent: "ChatGPT", kind: "invalid-chatgpt-message" });
        continue;
      }
      const time = new Date(m.create_time * 1000);
      if (!Number.isFinite(+time)) {
        errors.push({ agent: "ChatGPT", kind: "invalid-chatgpt-time" });
        continue;
      }
      const key = "chatgpt:message:" + message;
      if (seen.has(key)) continue;
      seen.add(key);
      const date = format.format(time),
        usage = metadata.usage;
      const known =
        role === "assistant" &&
        usage &&
        Number.isSafeInteger(usage.input_tokens) &&
        usage.input_tokens >= 0 &&
        Number.isSafeInteger(usage.output_tokens) &&
        usage.output_tokens >= 0;
      const model = String(
        metadata.model_slug || c.default_model_slug || "unknown",
      ).slice(0, 200);
      events.push({
        id: key,
        day: date,
        agent: "ChatGPT",
        session: id,
        model,
        kind: "chat-message",
        role,
        tokensKnown: !!known,
        input: known ? usage.input_tokens : null,
        output: known ? usage.output_tokens : null,
        cached: known
          ? Math.min(
              usage.input_tokens,
              count(
                usage.cached_input_tokens ??
                  usage.input_tokens_details?.cached_tokens,
              ),
            )
          : null,
        cacheWrite: known ? 0 : null,
        reasoning: known
          ? Math.min(
              usage.output_tokens,
              count(
                usage.reasoning_output_tokens ??
                  usage.output_tokens_details?.reasoning_tokens,
              ),
            )
          : null,
      });
      if (captureText) {
        const groupKey = id + ":" + date;
        let g = groups.get(groupKey);
        if (!g) {
          g = {
            id,
            agent: "ChatGPT",
            day: date,
            project: clean(c.title || "").slice(0, 120),
            requests: [],
            results: [],
          };
          groups.set(groupKey, g);
        }
        const text = clean(
          (Array.isArray(content.parts) ? content.parts : [])
            .filter((p) => typeof p === "string")
            .join("\n"),
        );
        if (text) {
          const list = role === "user" ? g.requests : g.results;
          if (!list.includes(text)) list.push(text);
        }
      }
    }
  }
  const sessions = [...groups.values()].map((g) => ({
    ...g,
    requests: g.requests.slice(0, 4),
    results: g.results.slice(-2),
  }));
  const dates = events.map((e) => e.day).sort();
  return {
    version: 1,
    timezone,
    captureText,
    imported: true,
    scannedAt: new Date().toISOString(),
    coverageFrom: dates[0] || null,
    coverageTo: dates.at(-1) || null,
    events,
    sessions,
    inventory: [
      {
        agent: "ChatGPT",
        status: errors.length ? "partial" : "collected",
        files: documents.length,
        events: events.length,
      },
    ],
    errors,
  };
}
function scan(file, options) {
  return parse(readParts(path.resolve(file)), options);
}
module.exports = { scan, parse, branch, readParts };
