const fs = require('fs');
const { fetchUrlText } = require('./metadata');

/**
 * Formats seconds into HH:MM:SS
 * @param {number} sec 
 * @returns {string}
 */
function formatSeconds(sec) {
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  return [
    h.toString().padStart(2, '0'),
    m.toString().padStart(2, '0'),
    s.toString().padStart(2, '0')
  ].join(':');
}

/**
 * Extracts chat messages from BBB presentation data (slides_new.xml or chat.json)
 * @param {string} baseUrl e.g. https://domain/presentation/<id>/
 * @param {string} targetChatPath e.g. /path/to/meeting-chat.txt
 * @returns {Promise<string|null>} Path to saved chat file or null if no chat exists
 */
async function exportMeetingChat(baseUrl, targetChatPath, options = {}) {
  let messages = [];

  // Try 1: Check slides_new.xml (standard BBB 2.0 - 2.5)
  try {
    const slidesXml = await fetchUrlText(`${baseUrl}slides_new.xml`, options);
    const chatTimelineRegex = /<chattimeline[^>]*target="all"[^>]*name="([^"]*)"[^>]*message="([^"]*)"[^>]*time="([^"]*)"/gi;
    let match;
    while ((match = chatTimelineRegex.exec(slidesXml)) !== null) {
      const name = decodeHtml(match[1]);
      const text = decodeHtml(match[2]);
      const timeSec = parseFloat(match[3]) || 0;
      messages.push({ timeSec, name, text });
    }
  } catch {
    // slides_new.xml might not exist or failed
  }

  // Try 2: Check chat.json if no messages found in slides_new.xml
  if (messages.length === 0) {
    try {
      const chatJsonText = await fetchUrlText(`${baseUrl}chat.json`, options);
      const parsed = JSON.parse(chatJsonText);
      if (Array.isArray(parsed)) {
        messages = parsed.map(item => ({
          timeSec: (item.time || item.timestamp || 0) / 1000,
          name: item.name || item.username || 'User',
          text: item.message || item.text || ''
        }));
      }
    } catch {
      // chat.json not present
    }
  }

  if (messages.length === 0) {
    return null;
  }

  // Sort chronologically
  messages.sort((a, b) => a.timeSec - b.timeSec);

  // Format into clean readable text
  let outputContent = `=================================================\n`;
  outputContent += `Public Chat Log\n`;
  outputContent += `Total Messages: ${messages.length}\n`;
  outputContent += `=================================================\n\n`;

  for (const msg of messages) {
    outputContent += `[${formatSeconds(msg.timeSec)}] ${msg.name}: ${msg.text}\n`;
  }

  fs.writeFileSync(targetChatPath, outputContent, 'utf-8');
  return targetChatPath;
}

/**
 * Basic HTML entity decoder
 * @param {string} str 
 * @returns {string}
 */
function decodeHtml(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

module.exports = {
  exportMeetingChat,
  formatSeconds
};
