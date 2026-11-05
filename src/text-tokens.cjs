// Count visible text locally. This is not provider-reported or billable usage.
const ENCODING = "o200k_base";
let encoder;
function countText(text) {
  if (!text) return 0;
  if (!encoder) {
    const { Tiktoken } = require("js-tiktoken/lite");
    encoder = new Tiktoken(require("js-tiktoken/ranks/o200k_base"));
  }
  // Exported text may contain special-token spellings; treat them as plain text.
  return encoder.encode(text, [], []).length;
}
module.exports = { ENCODING, countText };
