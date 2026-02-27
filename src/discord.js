const axios = require("axios");

async function sendDiscord(webhookUrl, content) {
  if (!webhookUrl) return;
  await axios.post(webhookUrl, { content }, { timeout: 15000 });
}

module.exports = { sendDiscord };