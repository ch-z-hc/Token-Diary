const fs = require("node:fs");
const path = require("node:path");

async function withLock(file, run) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const pid = Number(fs.readFileSync(file, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 1)
      throw new Error("Invalid lock; inspect " + file);
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code !== "ESRCH") throw err;
      fs.unlinkSync(file);
      return withLock(file, run);
    }
    throw new Error("Another AI Log process is working");
  }
  fs.writeFileSync(fd, String(process.pid));
  fs.closeSync(fd);
  try {
    return await run();
  } finally {
    fs.rmSync(file, { force: true });
  }
}
module.exports = { withLock };
