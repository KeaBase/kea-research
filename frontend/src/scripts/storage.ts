/**
 * Storage Utilities
 */

import { KeaResearchDB } from './db';
import type { Step1Data, Step2Data, Step3Data, Step4Data } from './pipeline-types';
import { STORAGE_KEYS, UI_CONFIG } from './constants';

// Supported locales (must match i18n/index.ts)
const SUPPORTED_LOCALES = [
  'en', 'id', 'ms', 'ca', 'cs', 'da', 'de', 'es', 'fil', 'fr', 'it', 'hu',
  'nl', 'no', 'pl', 'pt', 'ro', 'fi', 'sv', 'vi', 'tr', 'el', 'uk', 'he',
  'ar', 'fa', 'ur', 'bn', 'hi', 'ta', 'th', 'zh', 'ja', 'ko'
];

/**
 * Detect browser language and return supported locale
 */
function detectBrowserLanguage(): string {
  const browserLang = navigator.language || (navigator as { userLanguage?: string }).userLanguage || 'en';
  const primaryLang = browserLang.split('-')[0].toLowerCase();
  return SUPPORTED_LOCALES.indexOf(primaryLang) !== -1 ? primaryLang : 'en';
}

// Chat and Message interfaces
export interface Chat {
  id?: number;
  title: string;
  createdAt: string;
  updatedAt: string;
  isBookmarked?: boolean;
  providerSetName?: string; // Provider set name used for this chat (e.g., "Deep Thinking")
}

export interface ProviderResponseData {
  content: string;
  error?: string;
}

export interface PipelineData {
  step1Responses: Record<string, Step1Data>;
  step2Responses: Record<string, Step2Data>;
  step3Responses: Record<string, Step3Data>;
  step4Response: Step4Data | null;
  synthesizer: string | null;
  errors: Record<string, string[]>;
}

// Multimodal content types (matches backend format)
export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageSource {
  type: 'base64';
  media_type: string;
  data: string;
}

export interface ImageContent {
  type: 'image';
  source: ImageSource;
}

export interface DocumentContent {
  type: 'document';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
  name: string;
  extension?: string;
}

export type MessageContent = string | Array<TextContent | ImageContent | DocumentContent>;

export interface ChatMessage {
  id?: number;
  chatId: number;
  role: 'user' | 'assistant';
  content: MessageContent;  // Updated to support multimodal content
  providerResponses?: Record<string, ProviderResponseData>;
  timestamp: string;
  pipelineData?: PipelineData;
}

export interface DraftItem {
  id: number;
  content: string;
  createdAt: string;
}

export interface UserSettings {
  theme: 'light' | 'dark' | 'auto';
  userName: string;
  language: string;
  sendOnEnter: boolean;
  compressAttachedImages: boolean;
  compressionQuality: number;
  compressionMaxDimension: number;
  avatar: string;
  background: string;
  avatarBlobId: string | null;
  backgroundBlobId: string | null;
  storageLimit: number;
  sidebarHidden: boolean;
  // TTS settings (Backend Kokoro TTS)
  ttsEnabled: boolean;
  ttsLanguage: 'en-us' | 'en-gb' | 'ja' | 'zh' | 'es' | 'fr' | 'hi' | 'it' | 'pt';
  ttsVoice: string;  // Any valid Kokoro voice ID
  ttsSpeed: number;
  // Pipeline view settings
  pipelineViewMode: 'formatted' | 'code';
}

/**
 * Update a single setting value (shorthand for get → modify → save pattern)
 * @param key - The setting key to update
 * @param value - The new value
 */
export async function updateSetting<K extends keyof UserSettings>(
  key: K,
  value: UserSettings[K]
): Promise<void> {
  const settings = await StorageUtils.getSettings();
  settings[key] = value;
  await StorageUtils.saveSettings(settings);
}

export const StorageUtils = {
  async getSettings(): Promise<UserSettings> {
    // Detect browser language for first-time users
    const detectedLang = detectBrowserLanguage();

    const defaults: UserSettings = {
      theme: 'auto',
      userName: 'User',
      language: detectedLang,
      sendOnEnter: true,
      compressAttachedImages: true,
      compressionQuality: 85,
      compressionMaxDimension: 2048,
      avatar: '😊',
      background: 'none',
      avatarBlobId: null,
      backgroundBlobId: null,
      storageLimit: 32,
      sidebarHidden: false,
      // TTS defaults
      ttsEnabled: false,
      ttsLanguage: 'en-us',
      ttsVoice: 'af_heart',
      ttsSpeed: 1.0,
      // Pipeline view defaults
      pipelineViewMode: 'formatted'
    };
    try {
      const stored = await KeaResearchDB.get('settings', 'userSettings') as { value: UserSettings } | undefined;
      if (stored) {
        return { ...defaults, ...stored.value };
      }
      // First visit: set language cookie for server-side rendering
      document.cookie = `${STORAGE_KEYS.LANGUAGE}=${detectedLang};path=/;max-age=${UI_CONFIG.COOKIE_MAX_AGE_SECONDS};SameSite=Lax`;
      return defaults;
    } catch (error) {
      console.error('Error getting settings:', error);
      return defaults;
    }
  },

  async saveSettings(settings: UserSettings): Promise<void> {
    try {
      await KeaResearchDB.put('settings', { key: 'userSettings', value: settings, updatedAt: new Date().toISOString() });
    } catch (error) {
      console.error('Error saving settings:', error);
    }
  },

  async saveAsset(type: string, blob: Blob): Promise<string> {
    try {
      const id = `${type}_${Date.now()}`;
      await KeaResearchDB.put('assets', { id: id, type: type, blob: blob, createdAt: new Date().toISOString() });
      return id;
    } catch (error) {
      console.error('Error saving asset:', error);
      throw error;
    }
  },

  async getAsset(id: string): Promise<Blob | null> {
    try {
      const asset = await KeaResearchDB.get('assets', id);
      return asset ? asset.blob : null;
    } catch (error) {
      console.error('Error getting asset:', error);
      return null;
    }
  },

  async getStorageInfo(): Promise<{ used: number; quota: number; percentage: string } | null> {
    const estimate = await KeaResearchDB.getStorageEstimate();
    const settings = await this.getSettings();
    const storageLimit = settings.storageLimit || 32;
    if (estimate) {
      return {
        used: estimate.used,
        quota: storageLimit,
        percentage: (estimate.used / storageLimit * 100).toFixed(1)
      };
    }
    return null;
  },

  // ========== Chat CRUD ==========

  async createChat(title: string, providerSetName?: string): Promise<number> {
    const now = new Date().toISOString();
    const chat: Chat = {
      title: title.substring(0, 100), // Truncate title
      createdAt: now,
      updatedAt: now,
      providerSetName: providerSetName || undefined,
    };
    const id = await KeaResearchDB.put('chats', chat);
    return id as number;
  },

  async updateChat(chatId: number, data: Partial<Chat>): Promise<void> {
    const existing = await KeaResearchDB.get('chats', chatId);
    if (existing) {
      const updated = {
        ...existing,
        ...data,
        id: chatId,
        updatedAt: new Date().toISOString(),
      };
      await KeaResearchDB.put('chats', updated);
    }
  },

  async deleteChat(chatId: number): Promise<void> {
    // Delete all messages first
    await this.deleteMessages(chatId);
    // Then delete the chat
    await KeaResearchDB.delete('chats', chatId);
  },

  async getAllChats(): Promise<Chat[]> {
    const chats = await KeaResearchDB.getAll('chats');
    // Sort by updatedAt descending (most recent first)
    return chats.sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  },

  async getChat(chatId: number): Promise<Chat | null> {
    return await KeaResearchDB.get('chats', chatId);
  },

  // ========== Message CRUD ==========

  async saveMessage(message: ChatMessage): Promise<number> {
    const id = await KeaResearchDB.put('messages', message);
    // Update chat's updatedAt
    await this.updateChat(message.chatId, {});
    return id as number;
  },

  async getMessages(chatId: number): Promise<ChatMessage[]> {
    // Use index-based query for efficiency (avoids loading all messages)
    const messages = await KeaResearchDB.getAllByIndex<ChatMessage>('messages', 'chatId', chatId);
    // Sort by timestamp
    return messages.sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  },

  async deleteMessages(chatId: number): Promise<void> {
    // Use index-based deletion for efficiency (avoids loading all messages)
    await KeaResearchDB.deleteAllByIndex('messages', 'chatId', chatId);
  },

  // ========== Bookmark Operations ==========

  async toggleBookmark(chatId: number): Promise<boolean> {
    const chat = await KeaResearchDB.get('chats', chatId) as Chat | null;
    if (chat) {
      const newState = !chat.isBookmarked;
      const updated: Chat = {
        ...chat,
        isBookmarked: newState,
        updatedAt: new Date().toISOString(),
      };
      await KeaResearchDB.put('chats', updated);
      return newState;
    }
    return false;
  },

  async getBookmarkedChats(): Promise<Chat[]> {
    const chats = await KeaResearchDB.getAll('chats') as Chat[];
    return chats
      .filter((c: Chat) => c.isBookmarked === true)
      .sort((a: Chat, b: Chat) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
  },

  async getBookmarkCount(): Promise<number> {
    const chats = await KeaResearchDB.getAll('chats') as Chat[];
    return chats.filter((c: Chat) => c.isBookmarked === true).length;
  },

  // ========== Draft History Operations ==========

  /**
   * Save a draft to history (for new chat only)
   * Avoids duplicates by checking if same content already exists
   */
  async saveDraftToHistory(content: string): Promise<void> {
    if (!content.trim()) return;

    try {
      const stored = await KeaResearchDB.get<{ key: string; value: DraftItem[] }>('settings', 'draft_history');
      const drafts: DraftItem[] = stored?.value || [];

      // Check if this exact content already exists
      if (drafts.some(d => d.content === content)) return;

      // Add new draft with unique id
      const newId = drafts.length > 0 ? Math.max(...drafts.map(d => d.id)) + 1 : 1;
      drafts.unshift({
        id: newId,
        content,
        createdAt: new Date().toISOString()
      });

      // Keep only last 20 drafts
      const trimmed = drafts.slice(0, 20);

      await KeaResearchDB.put('settings', {
        key: 'draft_history',
        value: trimmed,
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error saving draft to history:', error);
    }
  },

  /**
   * Get all drafts from history
   */
  async getDraftHistory(): Promise<DraftItem[]> {
    try {
      const stored = await KeaResearchDB.get<{ key: string; value: DraftItem[] }>('settings', 'draft_history');
      return stored?.value || [];
    } catch (error) {
      console.error('Error getting draft history:', error);
      return [];
    }
  },

  /**
   * Delete a single draft from history by id
   */
  async deleteDraftFromHistory(id: number): Promise<void> {
    try {
      const stored = await KeaResearchDB.get<{ key: string; value: DraftItem[] }>('settings', 'draft_history');
      if (!stored?.value) return;

      const filtered = stored.value.filter(d => d.id !== id);
      await KeaResearchDB.put('settings', {
        key: 'draft_history',
        value: filtered,
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error deleting draft from history:', error);
    }
  },

  /**
   * Clear all drafts from history
   */
  async clearDraftHistory(): Promise<void> {
    try {
      await KeaResearchDB.delete('settings', 'draft_history');
    } catch (error) {
      console.error('Error clearing draft history:', error);
    }
  }
};

// Make it globally available
declare global {
  interface Window {
    StorageUtils: typeof StorageUtils;
  }
}

window.StorageUtils = StorageUtils;
