/**
 * Export Manager
 */

import { StorageUtils, Chat, ChatMessage, MessageContent, TextContent, ImageContent, DocumentContent } from './storage';
import { escapeHtml } from './utils';

declare function t(key: string, vars?: Record<string, string | number>): string;

interface ExportOptions {
  includeTimestamps: boolean;
  includeMetadata: boolean;
}

// Formatter type for provider response formatting
type ProviderFormatter = (provider: string, content: string) => string;

// Formatters for different export formats
const formatters = {
  markdown: (p: string, c: string) => `### ${p}\n${c}`,
  text: (p: string, c: string) => `[${p.toUpperCase()}]\n${c}`,
  html: (p: string, c: string) => `<div class="provider"><strong>${escapeHtml(p)}</strong><div>${escapeHtml(c)}</div></div>`
};

// Helper to check content types
function isTextContent(item: any): item is TextContent {
  return item && typeof item === 'object' && item.type === 'text';
}

function isImageContent(item: any): item is ImageContent {
  return item && typeof item === 'object' && item.type === 'image';
}

function isDocumentContent(item: any): item is DocumentContent {
  return item && typeof item === 'object' && item.type === 'document';
}

/**
 * Strip XML documents wrapper from text content
 * Returns only the user's message text after </documents> tag
 */
function stripDocumentsXML(text: string): string {
  const trimmed = text.trim();

  // Check if text starts with <documents> tag
  if (trimmed.indexOf('<documents>') === 0) {
    // Find the closing tag
    const closingTagIndex = trimmed.indexOf('</documents>');
    if (closingTagIndex !== -1) {
      // Extract text after </documents> tag
      const afterXML = trimmed.substring(closingTagIndex + '</documents>'.length);
      return afterXML.trim();
    }
  }

  // No XML wrapper found, return as-is
  return text;
}

// Helper to extract text from multimodal content
function extractText(content: MessageContent): string {
  if (typeof content === 'string') {
    return stripDocumentsXML(content);
  }
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const item of content) {
      if (isTextContent(item)) {
        // Strip XML from each text block
        const cleanText = stripDocumentsXML(item.text);
        if (cleanText) {
          textParts.push(cleanText);
        }
      }
    }
    return textParts.join('\n');
  }
  return '';
}

// Helper to get file attachments from multimodal content
function getAttachments(content: MessageContent): Array<{ type: 'image' | 'document'; name?: string; mediaType?: string; data?: string }> {
  if (!Array.isArray(content)) {
    return [];
  }
  const attachments: Array<{ type: 'image' | 'document'; name?: string; mediaType?: string; data?: string }> = [];
  for (const item of content) {
    if (isImageContent(item)) {
      attachments.push({
        type: 'image',
        mediaType: item.source.media_type,
        data: item.source.data
      });
    } else if (isDocumentContent(item)) {
      attachments.push({
        type: 'document',
        name: item.name,
        mediaType: item.source.media_type,
        data: item.source.data
      });
    }
  }
  return attachments;
}

// Helper to clean content for JSON export (strip XML and file data, keep only metadata)
function cleanContentForExport(content: MessageContent): any {
  if (typeof content === 'string') {
    return stripDocumentsXML(content);
  }
  if (Array.isArray(content)) {
    return content.map(item => {
      if (isTextContent(item)) {
        // Strip XML from text blocks
        return {
          ...item,
          text: stripDocumentsXML(item.text)
        };
      }
      if (isImageContent(item)) {
        // Keep only metadata for images, remove base64 data
        return {
          type: 'image',
          source: {
            type: item.source.type,
            media_type: item.source.media_type
            // data field removed to reduce file size
          }
        };
      }
      if (isDocumentContent(item)) {
        // Keep only metadata for documents, remove base64 data
        return {
          type: 'document',
          name: item.name,
          source: {
            type: item.source.type,
            media_type: item.source.media_type
            // data field removed to reduce file size
          }
        };
      }
      // Preserve other types as-is
      return item;
    });
  }
  return content;
}

export const ExportManager = {
  // Generic helper to extract message content with custom formatting
  getFormattedContent(
    msg: ChatMessage,
    formatter: ProviderFormatter,
    separator: string,
    escapeUserContent: boolean
  ): string {
    if (msg.role === 'user' && msg.content) {
      const textContent = extractText(msg.content);
      return escapeUserContent ? escapeHtml(textContent) : textContent;
    }
    if (msg.providerResponses && Object.keys(msg.providerResponses).length > 0) {
      const entries: Array<[string, any]> = [];
      for (const key in msg.providerResponses) {
        if (msg.providerResponses.hasOwnProperty(key)) {
          entries.push([key, msg.providerResponses[key]]);
        }
      }
      return entries
        .filter(([_, data]) => data.content)
        .map(([provider, data]) => formatter(provider, data.content))
        .join(separator);
    }
    const fallback = extractText(msg.content || '');
    return escapeUserContent ? escapeHtml(fallback) : fallback;
  },

  // Convenience methods using the generic helper
  getMessageContent(msg: ChatMessage): string {
    return this.getFormattedContent(msg, formatters.markdown, '\n\n', false);
  },

  getMessageContentText(msg: ChatMessage): string {
    return this.getFormattedContent(msg, formatters.text, '\n\n', false);
  },

  getMessageContentHTML(msg: ChatMessage): string {
    return this.getFormattedContent(msg, formatters.html, '', true);
  },

  getFilename(format: string, chatTitle: string): string {
    const date = new Date().toISOString().split('T')[0];
    const sanitizedTitle = (chatTitle || 'chat').replace(/[^a-z0-9]/gi, '_').toLowerCase().substring(0, 25);
    return `kea_${sanitizedTitle}_${date}.${format}`;
  },

  exportMarkdown(chat: Chat, messages: ChatMessage[], options: ExportOptions): string {
    const lines: string[] = [];
    if (options.includeMetadata) {
      lines.push(`# ${chat.title || t('js.chatExport')}`);
      lines.push(`**${t('js.exportDate')}**: ${new Date().toISOString()}`);
      lines.push(`**${t('js.messages')}**: ${messages.length}`);
      lines.push('', '---', '');
    }
    messages.forEach((msg, index) => {
      lines.push(`## ${t('js.message')} ${index + 1}`);
      lines.push(`**${msg.role === 'user' ? t('js.roleUser') : t('js.roleAssistant')}**`);
      if (options.includeTimestamps && msg.timestamp) {
        lines.push(`*${new Date(msg.timestamp).toLocaleString()}*`);
      }
      lines.push('');

      // Add attachment info for user messages
      if (msg.role === 'user') {
        const attachments = getAttachments(msg.content);
        if (attachments.length > 0) {
          lines.push('**Attachments:**');
          attachments.forEach(att => {
            if (att.type === 'image') {
              lines.push(`- 📷 Image (${att.mediaType || 'unknown format'})`);
            } else if (att.type === 'document') {
              lines.push(`- 📄 File: ${att.name || 'unknown'} (${att.mediaType || 'unknown format'})`);
            }
          });
          lines.push('');
        }
      }

      lines.push(this.getMessageContent(msg), '', '---', '');
    });
    return lines.join('\n');
  },

  exportHTML(chat: Chat, messages: ChatMessage[], options: ExportOptions): string {
    const html: string[] = [];
    html.push('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">');
    html.push(`<title>${escapeHtml(chat.title || t('js.chatExport'))}</title>`);

    // Add CDN libraries for markdown and math rendering
    html.push('<script src="https://cdn.jsdelivr.net/npm/marked@17.0.1/lib/marked.umd.min.js"><\/script>');
    html.push('<script src="https://cdn.jsdelivr.net/npm/mathjax@4.1.0/tex-chtml.js" id="MathJax-script" async><\/script>');

    html.push('<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:900px;margin:40px auto;padding:20px;line-height:1.6;color:#333}');
    html.push('.header{border-bottom:2px solid #ddd;padding-bottom:20px;margin-bottom:30px}.message{margin-bottom:30px;padding:15px;border-radius:8px}');
    html.push('.user{background:#e3f2fd}.assistant{background:#f5f5f5}.role{font-weight:bold;font-size:1.1em;margin-bottom:8px}.timestamp{font-size:.85em;color:#666;margin:5px 0}');
    html.push('.attachments{margin:10px 0;padding:12px;background:#fff;border-radius:4px;border-left:3px solid #28a745}');
    html.push('.attachment-item{margin:8px 0;color:#555}.attachment-item a{color:#007bff;text-decoration:none;font-weight:500}.attachment-item a:hover{text-decoration:underline}');
    html.push('.content{margin-top:10px;word-wrap:break-word}.provider{margin:15px 0;padding:12px;background:#fff;border-left:3px solid #007bff;border-radius:4px}');
    html.push('.provider strong{color:#007bff;display:block;margin-bottom:8px}.provider .provider-content{white-space:pre-wrap}');
    html.push('code{background:#f4f4f4;padding:2px 6px;border-radius:3px;font-size:.9em}');
    html.push('pre{background:#f4f4f4;padding:12px;border-radius:4px;overflow-x:auto}pre code{background:none;padding:0}');
    html.push('</style></head><body>');

    if (options.includeMetadata) {
      html.push(`<div class="header"><h1>${escapeHtml(chat.title || t('js.chatExport'))}</h1>`);
      html.push(`<p><strong>${escapeHtml(t('js.exportDate'))}:</strong> ${escapeHtml(new Date().toLocaleString())}</p>`);
      html.push(`<p><strong>${escapeHtml(t('js.messages'))}:</strong> ${messages.length}</p></div>`);
    }

    messages.forEach((msg) => {
      html.push(`<div class="message ${msg.role}"><div class="role">${escapeHtml(msg.role === 'user' ? t('js.roleUser') : t('js.roleAssistant'))}</div>`);
      if (options.includeTimestamps && msg.timestamp) {
        html.push(`<div class="timestamp">${escapeHtml(new Date(msg.timestamp).toLocaleString())}</div>`);
      }

      // Add attachments for user messages
      if (msg.role === 'user') {
        const attachments = getAttachments(msg.content);
        if (attachments.length > 0) {
          html.push('<div class="attachments">');
          attachments.forEach((att, idx) => {
            if (att.type === 'image' && att.data) {
              // Embed image directly
              const dataUrl = `data:${att.mediaType || 'image/png'};base64,${att.data}`;
              html.push(`<div class="attachment-item"><img src="${escapeHtml(dataUrl)}" alt="Image ${idx + 1}" style="max-width:100%;height:auto;border-radius:4px;margin-top:8px;"></div>`);
            } else if (att.type === 'document' && att.data) {
              // Create download link
              const dataUrl = `data:${att.mediaType || 'application/octet-stream'};base64,${att.data}`;
              const fileName = escapeHtml(att.name || `file_${idx + 1}`);
              html.push(`<div class="attachment-item">📄 <a href="${escapeHtml(dataUrl)}" download="${fileName}" style="color:#007bff;text-decoration:none;">${fileName}</a> <span style="color:#666;font-size:0.9em;">(${escapeHtml(att.mediaType || 'unknown')})</span></div>`);
            }
          });
          html.push('</div>');
        }
      }

      // Render content with markdown support
      if (msg.role === 'user') {
        const textContent = extractText(msg.content);
        html.push(`<div class="content markdown-content">${escapeHtml(textContent)}</div></div>`);
      } else {
        // For assistant messages, render provider responses with markdown
        if (msg.providerResponses && Object.keys(msg.providerResponses).length > 0) {
          const entries: Array<[string, any]> = [];
          for (const key in msg.providerResponses) {
            if (msg.providerResponses.hasOwnProperty(key)) {
              entries.push([key, msg.providerResponses[key]]);
            }
          }
          entries
            .filter(([_, data]) => data.content)
            .forEach(([provider, data]) => {
              html.push(`<div class="provider"><strong>${escapeHtml(provider)}</strong>`);
              html.push(`<div class="provider-content markdown-content">${escapeHtml(data.content)}</div></div>`);
            });
          html.push('</div>');
        } else {
          const fallback = extractText(msg.content || '');
          html.push(`<div class="content markdown-content">${escapeHtml(fallback)}</div></div>`);
        }
      }
    });

    // Add script to render markdown after page loads
    html.push('<script>');
    html.push('window.addEventListener("DOMContentLoaded", function() {');
    html.push('  if (typeof marked !== "undefined") {');
    html.push('    marked.setOptions({ breaks: true, gfm: true });');
    html.push('    document.querySelectorAll(".markdown-content").forEach(function(el) {');
    html.push('      try { el.innerHTML = marked.parse(el.textContent || ""); } catch(e) {}');
    html.push('    });');
    html.push('  }');
    html.push('  if (typeof MathJax !== "undefined") {');
    html.push('    MathJax.typesetPromise().catch(function() {});');
    html.push('  }');
    html.push('});');
    html.push('<\/script>');

    html.push('</body></html>');
    return html.join('');
  },

  exportJSON(chat: Chat, messages: ChatMessage[], options: ExportOptions): string {
    return JSON.stringify({
      version: '1.0',
      exportDate: new Date().toISOString(),
      chat: { id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt },
      messages: messages.map(msg => ({
        id: msg.id,
        role: msg.role,
        content: msg.content ? cleanContentForExport(msg.content) : null,
        providerResponses: msg.providerResponses || undefined,
        timestamp: options.includeTimestamps ? msg.timestamp : undefined
      })),
      messageCount: messages.length
    }, null, 2);
  },

  exportText(chat: Chat, messages: ChatMessage[], options: ExportOptions): string {
    const lines: string[] = [];
    const separator = new Array(61).join('=');
    const divider = new Array(61).join('-');

    if (options.includeMetadata) {
      lines.push(`${t('js.chat')}: ${chat.title || t('js.untitled')}`);
      lines.push(`${t('js.exportDate')}: ${new Date().toLocaleString()}`);
      lines.push(`${t('js.messages')}: ${messages.length}`);
      lines.push('', separator, '');
    }

    messages.forEach((msg) => {
      lines.push(`[${msg.role === 'user' ? t('js.roleUser').toUpperCase() : t('js.roleAssistant').toUpperCase()}]`);
      if (options.includeTimestamps && msg.timestamp) {
        lines.push(`${t('js.time')}: ${new Date(msg.timestamp).toLocaleString()}`);
      }

      // Add attachments for user messages
      if (msg.role === 'user') {
        const attachments = getAttachments(msg.content);
        if (attachments.length > 0) {
          lines.push('');
          lines.push('Attachments:');
          attachments.forEach(att => {
            if (att.type === 'image') {
              lines.push(`  - Image (${att.mediaType || 'unknown format'})`);
            } else if (att.type === 'document') {
              lines.push(`  - File: ${att.name || 'unknown'} (${att.mediaType || 'unknown format'})`);
            }
          });
        }
      }

      lines.push('', this.getMessageContentText(msg), '', divider, '');
    });
    return lines.join('\n');
  },

  downloadFile(content: string, filename: string, mimeType: string): void {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  async exportChat(chatId: number, format: string, options: ExportOptions): Promise<{ success: boolean; filename: string }> {
    // Fetch real chat and messages from IndexedDB
    const chat = await StorageUtils.getChat(chatId);
    if (!chat) {
      throw new Error(t('js.chatNotFound'));
    }
    const messages = await StorageUtils.getMessages(chatId);

    let content: string, mimeType: string, extension: string;
    switch (format) {
      case 'markdown':
        content = this.exportMarkdown(chat, messages, options);
        mimeType = 'text/markdown';
        extension = 'md';
        break;
      case 'html':
        content = this.exportHTML(chat, messages, options);
        mimeType = 'text/html';
        extension = 'html';
        break;
      case 'json':
        content = this.exportJSON(chat, messages, options);
        mimeType = 'application/json';
        extension = 'json';
        break;
      case 'txt':
        content = this.exportText(chat, messages, options);
        mimeType = 'text/plain';
        extension = 'txt';
        break;
      default:
        throw new Error('Invalid format');
    }

    const filename = this.getFilename(extension, chat.title);
    this.downloadFile(content, filename, mimeType);
    return { success: true, filename };
  }
};

// Make it globally available
declare global {
  interface Window {
    ExportManager: typeof ExportManager;
  }
}

window.ExportManager = ExportManager;
