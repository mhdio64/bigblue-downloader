const { Notification } = require('electron');
const path = require('path');

/**
 * Sends a native Linux desktop notification
 * @param {string} title 
 * @param {string} body 
 * @param {object} options 
 */
function sendDesktopNotification(title, body, options = {}) {
  try {
    if (!Notification.isSupported()) {
      return;
    }

    const notification = new Notification({
      title: title || 'BigBlueButton Downloader',
      body: body || 'Operation completed successfully.',
      silent: false,
      urgency: 'normal',
      ...options
    });

    notification.show();
  } catch (err) {
    console.error('Failed to show desktop notification:', err.message);
  }
}

module.exports = {
  sendDesktopNotification
};
