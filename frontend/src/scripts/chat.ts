/**
 * Chat Manager with 4-Step KEA Pipeline
 *
 * Handles user input, message history, and pipeline execution.
 */

import { StorageUtils, PipelineData } from './storage';
import { AttachmentManager } from './attachments';
import { PipelineManager } from './pipeline';
import { escapeHtml, isMacOS, isTextAreaElement, isInputElement } from './utils';
import { fetchStream, ApiRequestError } from './api';
import { getActiveSetId, getActiveSetName, lockSelector, unlockSelector } from './provider-set-selector';

interface TextContent {
  type: 'text';
  text: string;
}

interface ImageSource {
  type: 'base64';
  media_type: string;
  data: string;
}

interface ImageContent {
  type: 'image';
  source: ImageSource;
}

interface DocumentContent {
  type: 'document';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
  name: string;
  extension?: string;  // File extension for icon display
}

type MessageContent = string | Array<TextContent | ImageContent | DocumentContent>;

interface Message {
  role: 'user' | 'assistant';
  content: MessageContent;
}

const CHAT_EXPANDED_KEY = 'kea_chat_expanded';

export const ChatManager = {
  currentChatId: null as number | null,
  currentSetName: null as string | null, // Provider set name for this chat
  sendOnEnter: true,
  messages: [] as Message[],
  abortController: null as AbortController | null,
  isExpanded: false,
  _autoGrowListenerAttached: false, // Track listener state to prevent memory leaks

  async init(): Promise<void> {
    const settings = await StorageUtils.getSettings();
    this.sendOnEnter = settings.sendOnEnter;

    // Note: Provider icons are resolved from PROVIDER_CONFIG defaults in constants.ts
    // The public /api/providers endpoint only returns provider names, not full details with icons

    const sendBtn = document.getElementById('sendBtn');
    if (sendBtn) {
      sendBtn.addEventListener('click', () => this.sendMessage());
    }

    const chatInput = document.getElementById('chatInput');
    if (isTextAreaElement(chatInput)) {
      chatInput.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          const modifierPressed = isMacOS() ? e.metaKey : e.ctrlKey;

          if (this.sendOnEnter) {
            if (!e.shiftKey) {
              e.preventDefault();
              this.sendMessage();
            }
          } else {
            if (modifierPressed) {
              e.preventDefault();
              this.sendMessage();
            }
          }
        }
      });
    }

    const newChatBtn = document.getElementById('newChatBtn');
    if (newChatBtn) {
      newChatBtn.addEventListener('click', () => this.newChat());
    }

    const sendOnEnterToggle = document.getElementById('sendOnEnterToggle');
    if (isInputElement(sendOnEnterToggle)) {
      sendOnEnterToggle.addEventListener('change', () => {
        this.sendOnEnter = sendOnEnterToggle.checked;
      });
    }

    // Add stop button listener
    const stopBtn = document.getElementById('stopBtn');
    if (stopBtn) {
      stopBtn.addEventListener('click', () => this.stopStream());
    }

    // Initialize expand/collapse button
    this.initExpandButton();

    // Initialize draft history
    this.initDraftHistory();
  },

  initExpandButton(): void {
    const expandBtn = document.getElementById('expandChatBtn');
    if (!expandBtn) return;

    // Load saved state from localStorage
    this.isExpanded = localStorage.getItem(CHAT_EXPANDED_KEY) === 'true';
    this.applyExpandState();

    expandBtn.addEventListener('click', () => this.toggleExpand());
  },

  toggleExpand(): void {
    this.isExpanded = !this.isExpanded;
    localStorage.setItem(CHAT_EXPANDED_KEY, String(this.isExpanded));
    this.applyExpandState();
  },

  applyExpandState(): void {
    const chatContainer = document.getElementById('chatContainer');
    const expandBtn = document.getElementById('expandChatBtn');
    const icon = expandBtn?.querySelector('i');

    if (chatContainer) {
      if (this.isExpanded) {
        chatContainer.style.maxWidth = '97%';
      } else {
        chatContainer.style.maxWidth = '';
      }
    }

    if (icon) {
      icon.className = this.isExpanded
        ? 'bi bi-arrows-collapse-vertical'
        : 'bi bi-arrows-expand-vertical';
    }
  },

  showExpandButton(): void {
    const expandBtn = document.getElementById('expandChatBtn');
    if (expandBtn) {
      expandBtn.classList.remove('d-none');
    }
  },

  hideExpandButton(): void {
    const expandBtn = document.getElementById('expandChatBtn');
    if (expandBtn) {
      expandBtn.classList.add('d-none');
    }
  },

  enableChatActiveLayout(): void {
    const inputContainer = document.getElementById('chatInputContainer');
    const chatInput = document.getElementById('chatInput') as HTMLTextAreaElement | null;

    if (inputContainer) {
      inputContainer.classList.add('chat-active');
    }

    // Only add listener if not already attached (prevents memory leak from duplicate listeners)
    if (chatInput && !this._autoGrowListenerAttached) {
      chatInput.rows = 2;
      chatInput.addEventListener('input', this.handleTextareaAutoGrow);
      this._autoGrowListenerAttached = true;
      this.handleTextareaAutoGrow.call(chatInput);
    } else if (chatInput) {
      // Already attached, just reset height
      chatInput.rows = 2;
      this.handleTextareaAutoGrow.call(chatInput);
    }
  },

  disableChatActiveLayout(): void {
    const inputContainer = document.getElementById('chatInputContainer');
    const chatInput = document.getElementById('chatInput') as HTMLTextAreaElement | null;

    if (inputContainer) {
      inputContainer.classList.remove('chat-active');
    }

    if (chatInput && this._autoGrowListenerAttached) {
      chatInput.rows = 3;
      chatInput.style.height = '';
      chatInput.removeEventListener('input', this.handleTextareaAutoGrow);
      this._autoGrowListenerAttached = false;
    } else if (chatInput) {
      chatInput.rows = 3;
      chatInput.style.height = '';
    }
  },

  handleTextareaAutoGrow(this: HTMLTextAreaElement): void {
    // Reset height to recalculate
    this.style.height = 'auto';
    // Calculate line height (approx 24px per line)
    const lineHeight = 24;
    const minRows = 2;
    const maxRows = 5;
    const minHeight = lineHeight * minRows;
    const maxHeight = lineHeight * maxRows;
    // Set new height, clamped between min and max
    const newHeight = Math.min(Math.max(this.scrollHeight, minHeight), maxHeight);
    this.style.height = newHeight + 'px';
    // Add overflow if content exceeds max height
    this.style.overflowY = this.scrollHeight > maxHeight ? 'auto' : 'hidden';
  },

  async sendMessage(): Promise<void> {
    const input = document.getElementById('chatInput');
    if (!isTextAreaElement(input)) return;

    const message = input.value.trim();
    const attachments = AttachmentManager.attachments;

    if (!message && attachments.length === 0) return;

    // Hide welcome message
    this.hideWelcome();

    // Create chat if this is the first message
    if (this.currentChatId === null) {
      try {
        // Lock provider set selector and capture set name for this chat
        this.currentSetName = getActiveSetName();

        // Create chat with provider set name (use text-only for title)
        this.currentChatId = await StorageUtils.createChat(message, this.currentSetName || undefined);

        lockSelector();
        this.displaySetIndicator();

        // Update sidebar to show new chat
        if (window.SidebarManager) {
          window.SidebarManager.setActiveChat(this.currentChatId);
          await window.SidebarManager.loadChatHistory();
        }
      } catch (error) {
        console.error('Error creating chat:', error);
        this.showGlobalError('Failed to create chat. Please try again.');
        return; // Don't continue if chat creation failed
      }
    }

    // Build message content (text-only or multimodal)
    let messageContent: MessageContent;
    const imageAttachments = attachments.filter(att => att.type === 'image');
    const fileAttachments = attachments.filter(att => att.type === 'file');

    if (imageAttachments.length > 0 || fileAttachments.length > 0) {
      // Multimodal message: array of content blocks
      const contentBlocks: Array<TextContent | ImageContent | DocumentContent> = [];

      // Build text for AI (user input + XML for files)
      let aiText = message;

      // Convert files to base64
      const fileDataMap = new Map<any, { dataUrl: string; mediaType: string; base64Data: string }>();

      if (fileAttachments.length > 0) {
        // Read each file once and cache the result
        for (const att of fileAttachments) {
          if (!att.file) continue;

          try {
            const dataUrl = await this.convertFileToBase64(att.file);
            const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
            if (!match) {
              console.error('Invalid data URL format for file:', att.name);
              continue;
            }

            const [, mediaType, base64Data] = match;
            fileDataMap.set(att, { dataUrl, mediaType, base64Data });
          } catch (error) {
            console.error('Failed to convert file to base64:', att.name, error);
            alert(`Failed to read file: ${att.name}\n${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }

        // Build XML from cached base64 data
        const documentsXML = this.buildDocumentsXMLFromBase64(fileDataMap);
        if (message) {
          aiText = documentsXML + '\n\n' + message;
        } else {
          aiText = documentsXML;
        }
      }

      // Add text block if there's any text
      if (aiText) {
        contentBlocks.push({ type: 'text', text: aiText });
      }

      // Add image blocks
      for (const att of imageAttachments) {
        if (!att.file) continue;

        try {
          // Convert image to base64 data URL
          const dataUrl = await AttachmentManager.convertImageToBase64(att.file);

          // Split data URL into media type and base64 data
          // Format: "data:image/jpeg;base64,iVBORw0..."
          const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (!match) {
            console.error('Invalid data URL format for image:', att.name);
            continue;
          }

          const [, mediaType, base64Data] = match;

          // Add image content block
          contentBlocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: base64Data
            }
          });
        } catch (error) {
          console.error('Failed to convert image to base64:', att.name, error);
          alert(`Failed to read image: ${att.name}\n${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      // Add document blocks using cached base64 data
      for (const att of fileAttachments) {
        const fileData = fileDataMap.get(att);
        if (!fileData) continue;

        const filename = att.name || att.file.name;
        const extension = AttachmentManager.getFileExtension(filename);

        contentBlocks.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: fileData.mediaType,
            data: fileData.base64Data
          },
          name: filename,
          extension: extension
        });
      }

      messageContent = contentBlocks;
    } else {
      // Text-only message
      messageContent = message;
    }

    // Add user message to history
    this.messages.push({ role: 'user', content: messageContent });

    // Save user message to IndexedDB
    if (this.currentChatId !== null) {
      try {
        await StorageUtils.saveMessage({
          chatId: this.currentChatId,
          role: 'user',
          content: messageContent,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        console.error('Error saving user message:', error);
      }
    }

    // Display user message
    this.displayUserMessage(messageContent, new Date().toISOString());

    // Clear input
    input.value = '';
    AttachmentManager.clearAttachments();

    // Show stop button, hide send button
    this.toggleSendStop(true);

    // Initialize pipeline state
    PipelineManager.reset();
    PipelineManager.state = PipelineManager.initState();

    // Create pipeline UI container
    const chatArea = document.getElementById('chatMessages');
    if (chatArea) {
      PipelineManager.createPipelineContainer(chatArea);
    }

    // Start pipeline streaming
    await this.runPipeline();

    // Hide stop button, show send button
    this.toggleSendStop(false);

    // Save assistant message with final answer and pipeline data to IndexedDB
    if (this.currentChatId !== null && PipelineManager.state?.step4Response) {
      try {
        const finalAnswer = PipelineManager.getFinalAnswer();
        if (finalAnswer && PipelineManager.state) {
          await StorageUtils.saveMessage({
            chatId: this.currentChatId,
            role: 'assistant',
            content: finalAnswer,
            providerResponses: {
              kea: {
                content: finalAnswer,
                error: undefined,
              },
            },
            pipelineData: {
              step1Responses: PipelineManager.state.step1Responses,
              step2Responses: PipelineManager.state.step2Responses,
              step3Responses: PipelineManager.state.step3Responses,
              step4Response: PipelineManager.state.step4Response,
              synthesizer: PipelineManager.state.synthesizer,
              errors: PipelineManager.state.errors,
            },
            timestamp: new Date().toISOString(),
          });

          // Add to in-memory messages for context
          this.messages.push({ role: 'assistant', content: finalAnswer });

          // Update sidebar to refresh timestamps
          if (window.SidebarManager) {
            await window.SidebarManager.loadChatHistory();
          }

          // Remove sent message from draft history (only after successful send)
          this.removeDraftByContent(message);
        }
      } catch (error) {
        console.error('Error saving assistant message:', error);
      }
    }
  },

  hideWelcome(): void {
    const welcome = document.getElementById('welcomeSection');
    if (welcome) {
      welcome.classList.add('d-none');
    }

    // Show expand button when chat is active
    this.showExpandButton();

    // Enable chat-active layout for input
    this.enableChatActiveLayout();

    // Enable sticky input layout
    const mainContent = document.getElementById('mainContent');
    const scrollArea = document.getElementById('chatScrollArea');
    const inputContainer = document.getElementById('chatInputContainer');

    if (mainContent) {
      mainContent.classList.remove('overflow-auto');
      mainContent.classList.add('overflow-hidden');
    }
    if (scrollArea) {
      scrollArea.classList.add('flex-grow-1', 'overflow-auto');
    }
    if (inputContainer) {
      inputContainer.classList.remove('mt-5');
      inputContainer.classList.add('flex-shrink-0', 'pt-3', 'pb-3');
    }
  },

  toggleSendStop(streaming: boolean): void {
    const sendBtn = document.getElementById('sendBtn');
    const stopBtn = document.getElementById('stopBtn');
    if (sendBtn) sendBtn.classList.toggle('d-none', streaming);
    if (stopBtn) stopBtn.classList.toggle('d-none', !streaming);
  },

  async runPipeline(): Promise<void> {
    this.abortController = new AbortController();

    try {
      // Filter out DocumentContent blocks before sending to backend (backend doesn't support them)
      const messagesForBackend = this.messages.map(msg => {
        if (Array.isArray(msg.content)) {
          // Filter out document blocks - backend doesn't support them
          const filteredContent = msg.content.filter(block => block.type !== 'document');
          return { role: msg.role, content: filteredContent };
        }
        return msg;
      });

      // Build request body with optional provider_set_id
      const requestBody: { messages: Message[]; provider_set_id?: number } = {
        messages: messagesForBackend,
      };

      const activeSetId = getActiveSetId();
      if (activeSetId !== null) {
        requestBody.provider_set_id = activeSetId;
      }

      const response = await fetchStream(
        '/api/chat',
        {
          method: 'POST',
          body: JSON.stringify(requestBody),
          signal: this.abortController.signal,
        },
        window.UserAuth?.getToken() || null
      );

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n\n');
          buffer = lines.pop() || '';

          for (const block of lines) {
            if (!block.trim()) continue;

            // Parse SSE event
            const eventMatch = block.match(/^event:\s*(\w+)/m);
            const dataMatch = block.match(/^data:\s*(.+)$/m);

            if (!eventMatch || !dataMatch) continue;

            const eventType = eventMatch[1];
            let data: Record<string, unknown>;

            try {
              data = JSON.parse(dataMatch[1]);
            } catch {
              continue;
            }

            // Delegate to PipelineManager
            PipelineManager.handleSSEEvent(eventType, data);
          }
        }
      } finally {
        // Always cleanup the stream reader to prevent memory leaks
        reader.cancel().catch(() => {});
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        console.log('Pipeline aborted by user');
      } else if (error instanceof ApiRequestError) {
        console.error('Pipeline API error:', error.message, 'Status:', error.status);
        this.showGlobalError(error.message);
      } else {
        console.error('Pipeline error:', error);
        this.showGlobalError((error as Error).message);
      }
    } finally {
      this.abortController = null;
    }
  },

  displayUserMessage(content: MessageContent, timestamp?: string): void {
    const chatArea = document.getElementById('chatMessages');
    if (!chatArea) return;

    let contentHTML = '';
    const documentBlocks: DocumentContent[] = [];

    if (typeof content === 'string') {
      // Text-only message
      contentHTML = `<div>${escapeHtml(content)}</div>`;
    } else {
      // Multimodal message - separate text, images, and documents
      const textParts: string[] = [];
      const imageParts: string[] = [];

      for (const block of content) {
        if (block.type === 'text') {
          // Filter out XML documents from display (already shown as cards)
          const text = block.text;
          const trimmedText = text.trim();
          if (trimmedText.indexOf('<documents>') !== 0) {
            textParts.push(escapeHtml(text));
          } else {
            // Extract user message after XML
            const afterXML = text.split('</documents>')[1];
            if (afterXML && afterXML.trim()) {
              textParts.push(escapeHtml(afterXML.trim()));
            }
          }
        } else if (block.type === 'image') {
          // Reconstruct data URL for display
          const dataUrl = `data:${block.source.media_type};base64,${block.source.data}`;
          imageParts.push(`
            <div class="position-relative chat-image-container">
              <img
                src="${dataUrl}"
                class="rounded chat-message-image"
                alt="User image"
                onclick="window.open(this.src, '_blank')"
              />
              <a href="${dataUrl}" download="image.jpg"
                 class="chat-image-download-icon position-absolute"
                 onclick="event.stopPropagation()">
                <i class="bi bi-download"></i>
              </a>
            </div>
          `);
        } else if (block.type === 'document') {
          // Collect document blocks for rendering
          documentBlocks.push(block);
        }
      }

      // Display text first (if any)
      if (textParts.length > 0) {
        contentHTML += `<div class="mb-2">${textParts.join('<br>')}</div>`;
      }

      // Display images in horizontal scrollable row (if any)
      if (imageParts.length > 0) {
        contentHTML += `
          <div class="d-flex gap-2 overflow-x-auto pb-1 chat-message-images">
            ${imageParts.join('')}
          </div>
        `;
      }
    }

    // Display file attachments
    if (documentBlocks.length > 0) {
      const fileCardsHTML = documentBlocks.map(doc => {
        // Use stored extension if available, otherwise extract from filename
        const extension = doc.extension || AttachmentManager.getFileExtension(doc.name);
        const iconClass = AttachmentManager.getFileIcon(extension);

        // Reconstruct file size from base64 data
        const base64Length = doc.source.data.length;
        const sizeBytes = (base64Length * 3) / 4;
        const sizeKB = (sizeBytes / 1024).toFixed(1);

        // Create download link
        const dataUrl = `data:${doc.source.media_type};base64,${doc.source.data}`;

        return `
          <a href="${dataUrl}" download="${escapeHtml(doc.name)}"
             class="file-attachment-card text-decoration-none">
            <div class="d-flex align-items-center gap-2 bg-body-secondary rounded p-2">
              <i class="${iconClass} fs-4 text-primary flex-shrink-0"></i>
              <div class="flex-grow-1 overflow-hidden">
                <div class="small fw-semibold text-body text-truncate">${escapeHtml(doc.name)}</div>
                <div class="text-muted" style="font-size: 0.75rem;">${sizeKB} KB</div>
              </div>
              <i class="bi bi-download text-muted flex-shrink-0"></i>
            </div>
          </a>
        `;
      }).join('');

      contentHTML += `
        <div class="file-attachments-container mt-2 d-flex gap-2 overflow-x-auto pb-1">
          ${fileCardsHTML}
        </div>
      `;
    }

    const messageHTML = `
      <div class="user-message mb-3">
        <div class="d-flex justify-content-end">
          <div class="bg-kea text-white rounded-3 p-3 synthesis-result">
            ${contentHTML}
          </div>
        </div>
        ${timestamp ? `
        <div class="d-flex justify-content-end mt-1">
          <small class="text-muted">
            <i class="bi bi-calendar2-event me-1"></i>${new Date(timestamp).toLocaleString()}
          </small>
        </div>
        ` : ''}
      </div>
    `;
    chatArea.insertAdjacentHTML('beforeend', messageHTML);
  },

  /**
   * Display provider set indicator at the start of chat
   */
  displaySetIndicator(): void {
    if (!this.currentSetName) return;

    const chatArea = document.getElementById('chatMessages');
    if (!chatArea) return;

    const indicatorHTML = `
      <div class="set-indicator text-center mb-3" id="chatSetIndicator">
        <small class="text-muted">
          <i class="bi bi-collection me-1"></i>
          Using <strong>${escapeHtml(this.currentSetName)}</strong> providers
        </small>
      </div>
    `;
    chatArea.insertAdjacentHTML('afterbegin', indicatorHTML);
  },

  showGlobalError(message: string): void {
    const chatArea = document.getElementById('chatMessages');
    if (!chatArea) return;

    chatArea.insertAdjacentHTML(
      'beforeend',
      `<div class="alert alert-danger mt-3"><i class="bi bi-exclamation-triangle me-2"></i>${escapeHtml(message)}</div>`
    );
  },

  stopStream(): void {
    // Abort if controller exists; cleanup happens in runPipeline's finally block
    if (this.abortController) {
      this.abortController.abort();
      // Hide all spinners since we're stopping mid-stream
      PipelineManager.hideAllSpinners();
    }
  },

  // ========== Draft History Methods ==========

  /**
   * Save current textarea content to draft history (only for new chat)
   */
  async saveDraftToHistoryIfNeeded(): Promise<void> {
    if (this.currentChatId !== null) return; // Only for new chat

    const input = document.getElementById('chatInput');
    if (!isTextAreaElement(input) || !input.value.trim()) return;

    await StorageUtils.saveDraftToHistory(input.value);
    this.updateDraftHistoryButton();
  },

  /**
   * Update draft history button visibility
   */
  async updateDraftHistoryButton(): Promise<void> {
    const drafts = await StorageUtils.getDraftHistory();
    const wrapper = document.getElementById('draftHistoryWrapper');

    if (wrapper) {
      // Only show if we have drafts AND we're in new chat mode
      const shouldShow = drafts.length > 0 && this.currentChatId === null;
      wrapper.classList.toggle('d-none', !shouldShow);
    }
  },

  /**
   * Populate draft history dropdown with items
   */
  async populateDraftHistory(): Promise<void> {
    const listEl = document.getElementById('draftHistoryList');
    if (!listEl) return;

    const drafts = await StorageUtils.getDraftHistory();

    if (drafts.length === 0) {
      listEl.innerHTML = '<div class="text-muted text-center py-2"><small>No saved drafts</small></div>';
      return;
    }

    listEl.innerHTML = drafts.map(draft => {
      const date = new Date(draft.createdAt);
      const formattedDate = date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
      const preview = draft.content.length > 80
        ? draft.content.substring(0, 80) + '...'
        : draft.content;

      return `
        <div class="draft-item border rounded p-2 mb-2 bg-body-tertiary" data-draft-id="${draft.id}">
          <div class="d-flex justify-content-between align-items-start mb-1">
            <small class="text-muted">${formattedDate}</small>
            <button class="btn btn-sm btn-link text-danger p-0 delete-draft-btn" data-draft-id="${draft.id}" type="button">
              <i class="bi bi-x-lg"></i>
            </button>
          </div>
          <div class="draft-content small text-body restore-draft-btn" data-content="${escapeHtml(draft.content).replace(/"/g, '&quot;')}">
            ${escapeHtml(preview)}
          </div>
        </div>
      `;
    }).join('');
  },

  /**
   * Remove a draft from history by its content (used after sending a message)
   */
  async removeDraftByContent(content: string): Promise<void> {
    const drafts = await StorageUtils.getDraftHistory();
    const trimmedContent = content.trim();
    for (const draft of drafts) {
      if (draft.content.trim() === trimmedContent) {
        await StorageUtils.deleteDraftFromHistory(draft.id);
        this.updateDraftHistoryButton();
        break;
      }
    }
  },

  /**
   * Restore a draft to the textarea
   */
  restoreDraft(content: string): void {
    const input = document.getElementById('chatInput');
    if (isTextAreaElement(input)) {
      input.value = content;
      input.focus();
      // Trigger auto-grow if in chat-active mode
      if (document.getElementById('chatInputContainer')?.classList.contains('chat-active')) {
        this.handleTextareaAutoGrow.call(input);
      }
    }
  },

  /**
   * Initialize draft history event listeners
   */
  initDraftHistory(): void {
    // Clear all drafts button
    const clearAllBtn = document.getElementById('clearAllDrafts');
    if (clearAllBtn) {
      clearAllBtn.addEventListener('click', async () => {
        if (!confirm('Delete all saved drafts?')) return;

        await StorageUtils.clearDraftHistory();
        this.updateDraftHistoryButton();
        // Close dropdown
        const dropdown = document.getElementById('draftHistoryDropdown');
        if (dropdown) {
          dropdown.classList.remove('show');
        }
      });
    }

    // Delegate click events for draft list
    const listEl = document.getElementById('draftHistoryList');
    if (listEl) {
      listEl.addEventListener('click', async (e) => {
        const target = e.target as HTMLElement;

        // Delete draft
        const deleteBtn = target.closest('.delete-draft-btn') as HTMLElement;
        if (deleteBtn) {
          e.stopPropagation();
          const draftId = parseInt(deleteBtn.dataset.draftId || '0', 10);
          if (draftId) {
            await StorageUtils.deleteDraftFromHistory(draftId);
            await this.populateDraftHistory();
            this.updateDraftHistoryButton();
          }
          return;
        }

        // Restore draft
        const restoreEl = target.closest('.restore-draft-btn') as HTMLElement;
        if (restoreEl) {
          const content = restoreEl.dataset.content || '';
          // Decode HTML entities
          const textarea = document.createElement('textarea');
          textarea.innerHTML = content;
          this.restoreDraft(textarea.value);
          // Close dropdown
          const dropdown = document.getElementById('draftHistoryDropdown');
          if (dropdown) {
            dropdown.classList.remove('show');
          }
        }
      });
    }

    // Populate on dropdown show
    const draftBtn = document.getElementById('draftHistoryBtn');
    if (draftBtn) {
      draftBtn.addEventListener('click', () => this.populateDraftHistory());
    }

    // Save draft before page unload (refresh/close)
    window.addEventListener('beforeunload', () => {
      // Use synchronous approach for beforeunload
      if (this.currentChatId === null) {
        const input = document.getElementById('chatInput');
        if (isTextAreaElement(input) && input.value.trim()) {
          // Save synchronously using localStorage as backup, then sync to IndexedDB on next load
          const existing = localStorage.getItem('kea_pending_draft');
          if (!existing || existing !== input.value) {
            localStorage.setItem('kea_pending_draft', input.value);
          }
        }
      }
    });

    // Check for pending draft from localStorage (saved before page unload)
    const pendingDraft = localStorage.getItem('kea_pending_draft');
    if (pendingDraft) {
      StorageUtils.saveDraftToHistory(pendingDraft)
        .then(() => {
          localStorage.removeItem('kea_pending_draft');
          this.updateDraftHistoryButton();
        })
        .catch((error) => {
          // Keep draft in localStorage for retry on next page load
          console.warn('Draft save to IndexedDB failed, will retry on next load:', error);
        });
    }

    // Initial visibility check
    this.updateDraftHistoryButton();
  },

  async newChat(): Promise<void> {
    this.stopStream();

    // Save current draft to history before switching (only if in new chat)
    await this.saveDraftToHistoryIfNeeded();

    this.currentChatId = null;
    this.currentSetName = null;
    this.messages = [];
    PipelineManager.reset();

    // Unlock provider set selector for new chat
    unlockSelector();

    const chatInput = document.getElementById('chatInput');
    if (isTextAreaElement(chatInput)) {
      chatInput.value = '';
      chatInput.focus();
    }

    const chatMessages = document.getElementById('chatMessages');
    if (chatMessages) {
      chatMessages.innerHTML = '';
    }

    // Show welcome
    const welcome = document.getElementById('welcomeSection');
    if (welcome) {
      welcome.classList.remove('d-none');
    }

    // Hide expand button on new chat
    this.hideExpandButton();

    // Disable chat-active layout for input
    this.disableChatActiveLayout();

    // Reset to initial layout (not sticky)
    const mainContent = document.getElementById('mainContent');
    const scrollArea = document.getElementById('chatScrollArea');
    const inputContainer = document.getElementById('chatInputContainer');

    if (mainContent) {
      mainContent.classList.add('overflow-auto');
      mainContent.classList.remove('overflow-hidden');
    }
    if (scrollArea) {
      scrollArea.classList.remove('flex-grow-1', 'overflow-auto');
    }
    if (inputContainer) {
      inputContainer.classList.add('mt-5');
      inputContainer.classList.remove('flex-shrink-0', 'pt-3', 'pb-3');
    }

    // Clear active chat in sidebar
    if (window.SidebarManager) {
      window.SidebarManager.setActiveChat(null);
    }

    AttachmentManager.clearAttachments();

    // Update draft history button visibility (show if drafts exist)
    this.updateDraftHistoryButton();
  },

  async loadChat(chatId: number): Promise<void> {
    this.stopStream();

    // Save current draft to history before switching (only if in new chat)
    await this.saveDraftToHistoryIfNeeded();

    // Hide draft history button (it's only for new chat)
    const draftWrapper = document.getElementById('draftHistoryWrapper');
    if (draftWrapper) {
      draftWrapper.classList.add('d-none');
    }

    try {
      // Load messages from IndexedDB
      const messages = await StorageUtils.getMessages(chatId);

      if (messages.length === 0) {
        console.warn('No messages found for chat:', chatId);
        return;
      }

      // Load chat metadata to get provider set name
      const chat = await StorageUtils.getChat(chatId);
      const providerSetName = chat?.providerSetName || null;

      // Set current chat
      this.currentChatId = chatId;
      this.currentSetName = providerSetName;
      this.messages = [];
      PipelineManager.reset();

      // Lock selector when loading existing chat
      lockSelector();

      // Hide welcome, clear chat area
      this.hideWelcome();
      const chatMessages = document.getElementById('chatMessages');
      if (chatMessages) {
        chatMessages.innerHTML = '';
      }

      // Display provider set indicator if available
      if (this.currentSetName) {
        this.displaySetIndicator();
      }

      // Rebuild chat display from saved messages
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];

        if (msg.role === 'user') {
          // Add to in-memory messages
          this.messages.push({ role: 'user', content: msg.content });
          // Display user message
          this.displayUserMessage(msg.content, msg.timestamp);
        } else if (msg.role === 'assistant') {
          // Display assistant response
          const content = msg.content || (msg.providerResponses?.kea?.content);
          if (content) {
            // Check if we have pipeline data to restore full UI
            if (msg.pipelineData) {
              this.displayPipelineFromStorage(msg.pipelineData, msg.timestamp);
            } else {
              // Fallback: just show final answer card (old messages)
              this.displayAssistantMessage(content);
            }
            this.messages.push({ role: 'assistant', content });
          }
        }
      }

      // Focus input
      const chatInput = document.getElementById('chatInput');
      if (isTextAreaElement(chatInput)) {
        chatInput.focus();
      }
    } catch (error) {
      console.error('Error loading chat:', error);
    }
  },

  displayAssistantMessage(content: string): void {
    const chatArea = document.getElementById('chatMessages');
    if (!chatArea) return;

    // Render markdown if available
    let renderedContent: string;
    if (window.marked && typeof window.marked.parse === 'function') {
      try {
        renderedContent = window.marked.parse(content);
      } catch {
        renderedContent = escapeHtml(content);
      }
    } else {
      renderedContent = escapeHtml(content);
    }

    const messageHTML = `
      <div class="assistant-message mb-3">
        <div class="card border-success">
          <div class="card-header bg-success text-white py-1">
            <i class="bi bi-stars me-1"></i>
            <small>KEA Answer</small>
          </div>
          <div class="card-body">${renderedContent}</div>
        </div>
      </div>
    `;
    chatArea.insertAdjacentHTML('beforeend', messageHTML);
  },

  displayPipelineFromStorage(pipelineData: PipelineData, timestamp?: string): void {
    const chatArea = document.getElementById('chatMessages');
    if (!chatArea) return;

    // Restore PipelineManager state from stored data
    PipelineManager.reset();
    PipelineManager.state = {
      currentStep: 4,
      step1Responses: pipelineData.step1Responses,
      step2Responses: pipelineData.step2Responses,
      step3Responses: pipelineData.step3Responses,
      step4Response: pipelineData.step4Response,
      isComplete: true,
      errors: pipelineData.errors,
      synthesizer: pipelineData.synthesizer,
    };

    // Create pipeline container and restore UI from state
    PipelineManager.createPipelineContainer(chatArea);
    PipelineManager.restoreFromState(timestamp);
  },

  /**
   * Convert text file to base64 data URL
   */
  async convertFileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result); // Returns "data:text/plain;base64,..."
        } else {
          reject(new Error('FileReader result is not a string'));
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file); // Read as base64, not text
    });
  },

  /**
   * Extract text content from base64 file data
   */
  extractTextFromBase64(dataUrl: string): string {
    const match = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
    if (!match) return '';

    const base64Data = match[1];
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const decoder = new TextDecoder('utf-8');
    return decoder.decode(bytes);
  },

  /**
   * Build <documents> XML from cached base64 file data
   */
  buildDocumentsXMLFromBase64(fileDataMap: Map<any, { dataUrl: string; mediaType: string; base64Data: string }>): string {
    if (fileDataMap.size === 0) return '';

    const fileBlocks: string[] = [];

    fileDataMap.forEach((fileData, att) => {
      try {
        const textContent = this.extractTextFromBase64(fileData.dataUrl);
        const name = att.name || att.file?.name || 'untitled';

        // XML escape
        const escapedContent = textContent
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&apos;');

        fileBlocks.push(`<file name="${name}">\n${escapedContent}\n</file>`);
      } catch (error) {
        console.error('Failed to process file:', att.name, error);
      }
    });

    return '<documents>\n' + fileBlocks.join('\n') + '\n</documents>';
  }
};

// Make it globally available
declare global {
  interface Window {
    ChatManager: typeof ChatManager;
    marked: {
      parse: (markdown: string) => string;
    };
  }
}

window.ChatManager = ChatManager;
