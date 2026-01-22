/**
 * Pipeline Manager for 4-step KEA response system.
 *
 * Handles SSE stream parsing and UI updates for:
 * Step 1: Initial Responses
 * Step 2: MoA Refinement
 * Step 3: Peer Evaluation
 * Step 4: KEA Synthesis
 */

import {
  PipelineState,
  STEP_NAMES,
  STEP_BADGES,
  PROVIDER_CONFIG,
} from './pipeline-types';
import { escapeHtml, asString, asNumber, asBoolean } from './utils';
import { getProviderIconHtml, getProviderCache } from './constants';
import { ResponseRenderer, ViewMode } from './response-renderer';
import { stripCodeFences } from './json-highlighter';

export const PipelineManager = {
  state: null as PipelineState | null,
  responseCounter: 0,
  viewMode: 'formatted' as ViewMode,

  // Raw response buffers for each step/provider
  rawBuffers: {} as Record<string, Record<string, string>>,

  /**
   * Initialize a new pipeline state
   */
  initState(): PipelineState {
    return {
      currentStep: 0,
      step1Responses: {},
      step2Responses: {},
      step3Responses: {},
      step4Response: null,
      isComplete: false,
      errors: {},
      synthesizer: null,
    };
  },

  /**
   * Load view preference from IndexedDB
   */
  loadViewPreference(): void {
    ResponseRenderer.getViewPreference()
      .then((mode) => {
        this.viewMode = mode;
      })
      .catch(() => {
        this.viewMode = 'formatted';
      });
  },

  /**
   * Render LaTeX math expressions using MathJax
   * Supports: $$...$$ (block), $...$ (inline), \[...\] (block), \(...\) (inline)
   */
  renderMath(element: HTMLElement): void {
    if (!window.MathJax?.typesetPromise) return;

    window.MathJax.typesetPromise([element]).catch((err: Error) => {
      console.warn('MathJax typeset error:', err);
    });
  },

  /**
   * Create the pipeline UI container with Bootstrap components
   */
  createPipelineContainer(chatArea: HTMLElement): string {
    this.responseCounter++;
    const id = this.responseCounter;

    const html = `
      <div class="pipeline-container mb-4" id="pipeline-${id}">
        <!-- Step Progress Bar -->
        <div class="d-flex justify-content-between mb-2">
          ${[1, 2, 3, 4]
            .map(
              (n) => `
            <span class="badge bg-secondary" id="step-badge-${n}-${id}">${STEP_BADGES[n]}</span>
          `
            )
            .join('<i class="bi bi-arrow-right text-muted mx-1 align-self-center"></i>')}
        </div>
        <div class="progress mb-3" style="height: 6px;">
          <div class="progress-bar" id="pipeline-progress-${id}" role="progressbar" style="width: 0%"></div>
        </div>

        <!-- Step Details Accordion -->
        <div class="accordion accordion-flush" id="steps-accordion-${id}">
          ${[1, 2, 3, 4]
            .map(
              (n) => `
            <div class="accordion-item">
              <h2 class="accordion-header">
                <button class="accordion-button collapsed py-2" type="button"
                        data-bs-toggle="collapse"
                        data-bs-target="#step-collapse-${n}-${id}"
                        id="step-header-${n}-${id}">
                  <span class="spinner-border spinner-border-sm me-2 d-none" id="step-spinner-${n}-${id}"></span>
                  <span>Step ${n}: ${STEP_NAMES[n]}</span>
                  <span class="badge bg-secondary ms-2" id="step-count-${n}-${id}">0</span>
                </button>
              </h2>
              <div id="step-collapse-${n}-${id}" class="accordion-collapse collapse">
                <div class="accordion-body p-2" id="step-content-${n}-${id}"></div>
              </div>
            </div>
          `
            )
            .join('')}
        </div>

        <!-- Final Answer Card (hidden until Step 4 complete) -->
        <div class="card border-success mb-3 d-none" id="final-answer-card-${id}">
          <div class="card-header bg-success text-white d-flex align-items-center">
            <i class="bi bi-stars me-2"></i>
            <strong>KEA Final Answer</strong>
            <button class="btn btn-link btn-sm p-0 text-white ms-2 ${window.AppSettings?.ttsEnabled === false ? 'd-none' : ''}" id="tts-btn-${id}" title="Listen to answer">
              <i class="bi bi-volume-up"></i>
            </button>
            <button class="btn btn-link btn-sm p-0 text-white d-none" id="tts-restart-btn-${id}" title="Restart from beginning">
              <i class="bi bi-skip-start-fill"></i>
            </button>
            <span class="badge bg-light text-dark ms-auto" id="final-confidence-${id}"></span>
          </div>
          <div class="card-body" id="final-answer-content-${id}"></div>
          <div class="card-footer text-muted small d-flex align-items-center justify-content-between" id="final-meta-${id}">
            <span id="final-meta-text-${id}"></span>
            <div class="d-flex gap-2" id="final-actions-${id}">
              <button class="btn btn-link btn-sm p-0 text-muted" id="copy-btn-${id}" title="Copy to clipboard">
                <i class="bi bi-clipboard"></i>
              </button>
              <div class="dropdown d-inline-block">
                <button class="btn btn-link btn-sm p-0 text-muted" data-bs-toggle="dropdown" title="Export">
                  <i class="bi bi-box-arrow-up"></i>
                </button>
                <ul class="dropdown-menu dropdown-menu-end">
                  <li><button class="dropdown-item small" id="export-md-btn-${id}"><i class="bi bi-filetype-md me-2"></i>Markdown</button></li>
                  <li><button class="dropdown-item small" id="export-pdf-btn-${id}"><i class="bi bi-file-earmark-pdf me-2"></i>PDF</button></li>
                  <li><button class="dropdown-item small" id="export-doc-btn-${id}"><i class="bi bi-file-earmark-word me-2"></i>Word</button></li>
                  <li><button class="dropdown-item small" id="export-txt-btn-${id}"><i class="bi bi-file-earmark-text me-2"></i>Text</button></li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    chatArea.insertAdjacentHTML('beforeend', html);
    return `pipeline-${id}`;
  },

  /**
   * Handle step_start event
   */
  onStepStart(step: number): void {
    if (!this.state) return;
    this.state.currentStep = step;

    const id = this.responseCounter;

    // Update badge to active
    const badge = document.getElementById(`step-badge-${step}-${id}`);
    if (badge) {
      badge.classList.remove('bg-secondary', 'bg-success');
      badge.classList.add('bg-kea');
    }

    // Show spinner
    const spinner = document.getElementById(`step-spinner-${step}-${id}`);
    if (spinner) spinner.classList.remove('d-none');

    // Update progress bar
    const progress = document.getElementById(`pipeline-progress-${id}`);
    if (progress) {
      const percent = ((step - 1) / 4) * 100 + 12.5; // Start at 12.5% for step 1
      progress.style.width = `${percent}%`;
    }

    // Initialize raw buffer for this step
    this.rawBuffers[`step${step}`] = {};
  },

  /**
   * Handle step_complete event
   */
  onStepComplete(step: number, count: number): void {
    if (!this.state) return;
    const id = this.responseCounter;

    // Hide spinner
    const spinner = document.getElementById(`step-spinner-${step}-${id}`);
    if (spinner) spinner.classList.add('d-none');

    // Update badge to complete
    const badge = document.getElementById(`step-badge-${step}-${id}`);
    if (badge) {
      badge.classList.remove('bg-secondary', 'bg-kea');
      badge.classList.add('bg-success');
    }

    // Update count
    const countEl = document.getElementById(`step-count-${step}-${id}`);
    if (countEl) {
      countEl.textContent = String(count);
      countEl.classList.remove('bg-secondary');
      countEl.classList.add('bg-success');
    }

    // Update progress bar
    const progress = document.getElementById(`pipeline-progress-${id}`);
    if (progress) {
      const percent = (step / 4) * 100;
      progress.style.width = `${percent}%`;
    }
  },

  /**
   * Handle chunk events (step1_chunk, step2_chunk, etc.)
   */
  onChunk(step: number, provider: string, content: string): void {
    const id = this.responseCounter;
    const stepKey = `step${step}`;

    // Initialize buffer if needed
    if (!this.rawBuffers[stepKey]) this.rawBuffers[stepKey] = {};
    if (!this.rawBuffers[stepKey][provider]) {
      this.rawBuffers[stepKey][provider] = '';
      // Create provider tab in step content
      this.createProviderTab(step, provider);
    }

    // Append to buffer
    this.rawBuffers[stepKey][provider] += content;

    // Update UI
    const contentEl = document.getElementById(`step${step}-${provider}-content-${id}`);
    if (contentEl) {
      contentEl.textContent = this.rawBuffers[stepKey][provider];
    }
  },

  /**
   * Create tabs container for a step if it doesn't exist
   */
  createTabsContainer(step: number): void {
    const id = this.responseCounter;
    const stepContent = document.getElementById(`step-content-${step}-${id}`);
    if (!stepContent) return;

    // Check if tabs already exist
    if (document.getElementById(`step${step}-tabs-${id}`)) return;

    const html = `
      <ul class="nav nav-tabs" id="step${step}-tabs-${id}" role="tablist"></ul>
      <div class="tab-content border border-top-0 rounded-bottom p-2" id="step${step}-tabcontent-${id}"></div>
    `;
    stepContent.insertAdjacentHTML('beforeend', html);
  },

  /**
   * Create a tab for a provider within a step
   */
  createProviderTab(step: number, provider: string): void {
    const id = this.responseCounter;

    // Ensure tabs container exists
    this.createTabsContainer(step);

    const tabList = document.getElementById(`step${step}-tabs-${id}`);
    const tabContent = document.getElementById(`step${step}-tabcontent-${id}`);
    if (!tabList || !tabContent) return;

    const config = PROVIDER_CONFIG[provider] || { name: provider, icon: 'bi-robot', color: '#6c757d' };
    const cached = getProviderCache()[provider];
    const displayName = cached?.display_name || config.name;
    const isFirst = tabList.children.length === 0;
    const tabId = `step${step}-${provider}-tab-${id}`;
    const paneId = `step${step}-${provider}-pane-${id}`;

    // Create icon HTML using provider's custom icon or default
    const iconHtml = `<span class="me-1">${getProviderIconHtml(provider)}</span>`;

    // Create tab button with icon
    const tabHtml = `
      <li class="nav-item" role="presentation">
        <button class="nav-link ${isFirst ? 'active' : ''} py-1 px-2" id="${tabId}"
                data-bs-toggle="tab" data-bs-target="#${paneId}"
                type="button" role="tab">
          ${iconHtml}
          <small>${displayName}</small>
          <span class="spinner-border spinner-border-sm ms-1" style="width: 0.6rem; height: 0.6rem;"
                id="step${step}-${provider}-spinner-${id}"></span>
        </button>
      </li>
    `;
    tabList.insertAdjacentHTML('beforeend', tabHtml);

    // Create tab pane with streaming placeholder (will be replaced when done)
    const paneHtml = `
      <div class="tab-pane fade ${isFirst ? 'show active' : ''}" id="${paneId}" role="tabpanel">
        <div class="streaming-content" id="step${step}-${provider}-streaming-${id}">
          <pre class="mb-0 small text-muted font-monospace" style="white-space: pre-wrap; max-height: 200px; overflow-y: auto;"
               id="step${step}-${provider}-content-${id}"></pre>
        </div>
        <div class="rendered-content d-none" id="step${step}-${provider}-rendered-${id}"></div>
      </div>
    `;
    tabContent.insertAdjacentHTML('beforeend', paneHtml);

    // Update step count
    const countEl = document.getElementById(`step-count-${step}-${id}`);
    if (countEl) {
      const current = parseInt(countEl.textContent || '0');
      countEl.textContent = String(current + 1);
    }
  },

  /**
   * Handle done events (step1_done, step2_done, etc.)
   */
  onProviderDone(step: number, provider: string, success: boolean, data: Record<string, unknown>): void {
    const id = this.responseCounter;

    // Hide spinner
    const spinner = document.getElementById(`step${step}-${provider}-spinner-${id}`);
    if (spinner) spinner.classList.add('d-none');

    // Add status icon to tab
    const tab = document.getElementById(`step${step}-${provider}-tab-${id}`);
    if (tab) {
      const icon = success
        ? '<i class="bi bi-check-circle text-success ms-1"></i>'
        : '<i class="bi bi-x-circle text-danger ms-1"></i>';
      tab.insertAdjacentHTML('beforeend', icon);

      // Add confidence badge if available
      if (data.confidence !== undefined) {
        const confidenceBadge = `<span class="badge bg-info ms-1">${(data.confidence as number).toFixed(2)}</span>`;
        tab.insertAdjacentHTML('beforeend', confidenceBadge);
      }
    }

    // Render formatted view (replace streaming content)
    if (success) {
      const streamingEl = document.getElementById(`step${step}-${provider}-streaming-${id}`);
      const renderedEl = document.getElementById(`step${step}-${provider}-rendered-${id}`);
      const rawContent = this.rawBuffers[`step${step}`]?.[provider] || '';

      if (streamingEl && renderedEl && rawContent) {
        // Hide streaming, show rendered
        streamingEl.classList.add('d-none');
        renderedEl.classList.remove('d-none');

        // Use parsed data from backend if available (handles malformed JSON from local LLMs)
        // Otherwise fall back to raw content
        let contentForRenderer = rawContent;
        if (data.parsed && typeof data.parsed === 'object') {
          try {
            contentForRenderer = JSON.stringify(data.parsed);
          } catch {
            // Fall back to raw content if stringify fails
          }
        }

        // Render with ResponseRenderer
        const renderedHtml = ResponseRenderer.renderContainer(
          step,
          provider,
          contentForRenderer,
          id,
          this.viewMode
        );
        renderedEl.innerHTML = renderedHtml;
      }
    }
  },

  /**
   * Handle step4_synthesizer event
   */
  onSynthesizerSelected(provider: string, _label: string): void {
    if (this.state) {
      this.state.synthesizer = provider;
    }

    const id = this.responseCounter;
    const stepContent = document.getElementById(`step-content-4-${id}`);
    if (stepContent) {
      const config = PROVIDER_CONFIG[provider] || { name: provider, icon: 'bi-robot', color: '#6c757d' };
      const cached = getProviderCache()[provider];
      const displayName = cached?.display_name || config.name;
      const iconHtml = `<span>${getProviderIconHtml(provider)}</span>`;
      stepContent.insertAdjacentHTML(
        'afterbegin',
        `<div class="alert alert-info py-1 mb-2 small">
          <i class="bi bi-award me-1"></i>
          Synthesizer: ${iconHtml} <strong>${displayName}</strong> (ranked #1)
        </div>`
      );
    }
  },

  /**
   * Handle step4_done event - show final answer
   */
  onStep4Done(provider: string, finalAnswer: string | null, confidence: number | null, timestamp?: string): void {
    if (!finalAnswer || !this.state) return;

    const id = this.responseCounter;

    // Extract answer from JSON if needed
    let displayAnswer = finalAnswer;
    if (finalAnswer.trim().indexOf('{') === 0) {
      try {
        const parsed = JSON.parse(finalAnswer);
        // Validate types before using parsed values
        if (typeof parsed.final_answer === 'string') {
          displayAnswer = parsed.final_answer;
        }
        // Also extract confidence from JSON if not provided
        if (confidence === null && typeof parsed.confidence === 'number' && !isNaN(parsed.confidence)) {
          confidence = parsed.confidence;
        }
      } catch {
        // Not valid JSON, use as-is
      }
    }

    // Show final answer card
    const card = document.getElementById(`final-answer-card-${id}`);
    if (card) card.classList.remove('d-none');

    // Set content (render as markdown if available)
    const contentEl = document.getElementById(`final-answer-content-${id}`);
    if (contentEl) {
      if (window.marked && typeof window.marked.parse === 'function') {
        try {
          contentEl.innerHTML = window.marked.parse(displayAnswer);
        } catch {
          contentEl.textContent = displayAnswer;
        }
      } else {
        contentEl.textContent = displayAnswer;
      }
      // Render math with KaTeX
      this.renderMath(contentEl);
    }

    // Set confidence
    if (confidence !== null) {
      const confEl = document.getElementById(`final-confidence-${id}`);
      if (confEl) {
        confEl.textContent = `Confidence: ${(confidence * 100).toFixed(0)}%`;
      }
    }

    // Set meta with provider icon
    const metaTextEl = document.getElementById(`final-meta-text-${id}`);
    if (metaTextEl) {
      const config = PROVIDER_CONFIG[provider] || { name: provider, icon: 'bi-robot', color: '#6c757d' };
      const cached = getProviderCache()[provider];
      const displayName = cached?.display_name || config.name;
      const iconHtml = `<span class="me-1">${getProviderIconHtml(provider)}</span>`;
      const timestampHtml = timestamp
        ? `<span class="mx-2">•</span><i class="bi bi-calendar2-event me-1"></i>${new Date(timestamp).toLocaleString()}`
        : '';
      metaTextEl.innerHTML = `${iconHtml} Synthesized by ${displayName}${timestampHtml}`;
    }

    // Attach action handlers (copy, export, TTS)
    const copyBtn = document.getElementById(`copy-btn-${id}`);
    const exportMdBtn = document.getElementById(`export-md-btn-${id}`);
    const exportPdfBtn = document.getElementById(`export-pdf-btn-${id}`);
    const exportDocBtn = document.getElementById(`export-doc-btn-${id}`);
    const exportTxtBtn = document.getElementById(`export-txt-btn-${id}`);
    const ttsBtn = document.getElementById(`tts-btn-${id}`);

    if (copyBtn && window.MessageActions) {
      copyBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.MessageActions.copyToClipboard(displayAnswer, copyBtn);
      });
    }

    // Export handlers - pass both raw markdown and rendered HTML
    const renderedHtml = contentEl?.innerHTML || '';

    if (exportMdBtn && window.MessageActions) {
      exportMdBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.MessageActions.downloadAsMarkdown(displayAnswer, exportMdBtn);
      });
    }

    if (exportPdfBtn && window.MessageActions) {
      exportPdfBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.MessageActions.downloadAsPDF(displayAnswer, renderedHtml, exportPdfBtn);
      });
    }

    if (exportDocBtn && window.MessageActions) {
      exportDocBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.MessageActions.downloadAsDOCX(displayAnswer, renderedHtml, exportDocBtn);
      });
    }

    if (exportTxtBtn && window.MessageActions) {
      exportTxtBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.MessageActions.downloadAsText(displayAnswer, exportTxtBtn);
      });
    }

    const ttsRestartBtn = document.getElementById(`tts-restart-btn-${id}`);

    if (ttsBtn && window.TTS) {
      ttsBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.TTS.speak(displayAnswer, ttsBtn, ttsRestartBtn);
      });
    }

    if (ttsRestartBtn && window.TTS) {
      ttsRestartBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.TTS.restart();
      });
    }

    // Update state with extracted answer
    if (this.state) {
      this.state.step4Response = {
        provider,
        final_answer: displayAnswer,
        confidence: confidence || 0.5,
        sources_used: [],
        excluded: [],
      };
    }
  },

  /**
   * Handle pipeline_complete event
   */
  onPipelineComplete(): void {
    if (!this.state) return;
    this.state.isComplete = true;

    const id = this.responseCounter;

    // Ensure progress bar is at 100%
    const progress = document.getElementById(`pipeline-progress-${id}`);
    if (progress) {
      progress.style.width = '100%';
      progress.classList.add('bg-success');
    }

    // Scroll final answer into view
    const finalCard = document.getElementById(`final-answer-card-${id}`);
    if (finalCard && !finalCard.classList.contains('d-none')) {
      finalCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  },

  /**
   * Handle error events
   */
  onError(step: number, provider: string, error: string): void {
    if (!this.state) return;

    if (!this.state.errors[`step${step}`]) {
      this.state.errors[`step${step}`] = [];
    }
    this.state.errors[`step${step}`].push(`${provider}: ${error}`);

    const id = this.responseCounter;

    // If we have a tab pane for this provider, show error there
    const contentEl = document.getElementById(`step${step}-${provider}-content-${id}`);
    if (contentEl) {
      contentEl.innerHTML = `<div class="alert alert-danger mb-0 py-1 small">
        <i class="bi bi-exclamation-triangle me-1"></i>${escapeHtml(error)}
      </div>`;
    }

    // Hide spinner and add error icon to tab
    const spinner = document.getElementById(`step${step}-${provider}-spinner-${id}`);
    if (spinner) spinner.classList.add('d-none');

    const tab = document.getElementById(`step${step}-${provider}-tab-${id}`);
    if (tab) {
      tab.insertAdjacentHTML('beforeend', '<i class="bi bi-x-circle text-danger ms-1"></i>');
    }
  },

  /**
   * Handle global pipeline error
   */
  onPipelineError(message: string): void {
    const id = this.responseCounter;
    const container = document.getElementById(`pipeline-${id}`);
    if (container) {
      container.insertAdjacentHTML(
        'afterbegin',
        `<div class="alert alert-danger">
          <i class="bi bi-exclamation-triangle me-2"></i>
          Pipeline error: ${escapeHtml(message)}
        </div>`
      );
    }
  },

  /**
   * Parse and handle a single SSE event
   */
  handleSSEEvent(eventType: string, data: Record<string, unknown>): void {
    // Validate that data has expected shape
    if (!data || typeof data !== 'object') return;
    const provider = asString(data.provider);

    // Handle system events
    if (eventType === 'step_start') {
      this.onStepStart(asNumber(data.step));
      return;
    }
    if (eventType === 'step_complete') {
      this.onStepComplete(asNumber(data.step), asNumber(data.count));
      return;
    }
    if (eventType === 'step4_synthesizer') {
      this.onSynthesizerSelected(provider, asString(data.label));
      return;
    }
    if (eventType === 'pipeline_complete') {
      this.onPipelineComplete();
      return;
    }
    if (eventType === 'error') {
      this.onPipelineError(asString(data.message, 'Unknown error'));
      return;
    }

    // Handle step-specific events (stepN_chunk, stepN_done, stepN_error)
    const stepMatch = eventType.match(/^step(\d)_(chunk|done|error)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[1]);
      const action = stepMatch[2];

      if (action === 'chunk') {
        this.onChunk(step, provider, asString(data.content));
      } else if (action === 'done') {
        this.onProviderDone(step, provider, asBoolean(data.success), data);
        this.storeStepResponse(step, provider);
        if (step === 4) {
          const finalAnswer = typeof data.final_answer === 'string' ? data.final_answer : null;
          const confidence = typeof data.confidence === 'number' ? data.confidence : null;
          this.onStep4Done(provider, finalAnswer, confidence, new Date().toISOString());
        }
      } else if (action === 'error') {
        this.onError(step, provider, asString(data.error));
      }
    }
  },

  /**
   * Store step response in state based on step number
   */
  storeStepResponse(step: number, provider: string): void {
    if (step === 1) this.storeStep1Response(provider);
    else if (step === 2) this.storeStep2Response(provider);
    else if (step === 3) this.storeStep3Response(provider);
  },

  /**
   * Parse and store Step 1 response from raw buffer
   */
  storeStep1Response(provider: string): void {
    if (!this.state) return;
    const raw = this.rawBuffers['step1']?.[provider];
    if (!raw) return;

    try {
      // Strip markdown code fences before parsing (LLMs often wrap JSON in ```json ... ```)
      const cleaned = stripCodeFences(raw);
      const parsed = JSON.parse(cleaned);
      this.state.step1Responses[provider] = {
        provider,
        answer: parsed.answer || '',
        confidence: parsed.confidence || 0.5,
        atomic_facts: parsed.atomic_facts || [],
        raw_response: raw,
      };
    } catch {
      // Store raw text as fallback
      this.state.step1Responses[provider] = {
        provider,
        answer: raw,
        confidence: 0.5,
        atomic_facts: [],
        raw_response: raw,
      };
    }
  },

  /**
   * Parse and store Step 2 response from raw buffer
   */
  storeStep2Response(provider: string): void {
    if (!this.state) return;
    const raw = this.rawBuffers['step2']?.[provider];
    if (!raw) return;

    try {
      // Strip markdown code fences before parsing (LLMs often wrap JSON in ```json ... ```)
      const cleaned = stripCodeFences(raw);
      const parsed = JSON.parse(cleaned);
      this.state.step2Responses[provider] = {
        provider,
        improved_answer: parsed.improved_answer || '',
        confidence: parsed.confidence || 0.5,
        improvements: parsed.improvements || [],
        raw_response: raw, // Preserve raw text for proper rendering from history
      };
    } catch {
      this.state.step2Responses[provider] = {
        provider,
        improved_answer: raw,
        confidence: 0.5,
        improvements: [],
        raw_response: raw, // Preserve raw text for proper rendering from history
      };
    }
  },

  /**
   * Parse and store Step 3 response from raw buffer
   */
  storeStep3Response(provider: string): void {
    if (!this.state) return;
    const raw = this.rawBuffers['step3']?.[provider];
    if (!raw) return;

    try {
      // Strip markdown code fences before parsing (LLMs often wrap JSON in ```json ... ```)
      const cleaned = stripCodeFences(raw);
      const parsed = JSON.parse(cleaned);
      this.state.step3Responses[provider] = {
        provider,
        ranking: parsed.ranking || [],
        predicted_winner: parsed.predicted_winner || '',
        evaluations: parsed.evaluations || {},
        flagged_facts: parsed.flagged_facts || [],
        consensus_facts: parsed.consensus_facts || [],
        raw_response: raw, // Always preserve raw text
      };
    } catch {
      // Store raw text as fallback (like Steps 1 & 2)
      this.state.step3Responses[provider] = {
        provider,
        ranking: [],
        predicted_winner: '',
        evaluations: {},
        flagged_facts: [],
        consensus_facts: [],
        raw_response: raw, // Preserve raw text for display
      };
    }
  },

  /**
   * Get the final answer from the pipeline state
   */
  getFinalAnswer(): string | null {
    return this.state?.step4Response?.final_answer || null;
  },

  /**
   * Reset the pipeline state
   */
  reset(): void {
    this.state = null;
    this.rawBuffers = {};
  },

  /**
   * Hide all active spinners (called when request is aborted)
   */
  hideAllSpinners(): void {
    const id = this.responseCounter;

    // Hide step header spinners
    for (let step = 1; step <= 4; step++) {
      const stepSpinner = document.getElementById(`step-spinner-${step}-${id}`);
      if (stepSpinner) stepSpinner.classList.add('d-none');
    }

    // Hide provider tab spinners - dynamically get providers from tracked buffers
    for (let step = 1; step <= 4; step++) {
      const stepKey = `step${step}`;
      const stepProviders = this.rawBuffers[stepKey] ? Object.keys(this.rawBuffers[stepKey]) : [];
      for (const provider of stepProviders) {
        const providerSpinner = document.getElementById(`step${step}-${provider}-spinner-${id}`);
        if (providerSpinner) providerSpinner.classList.add('d-none');
      }
    }
  },

  /**
   * Restore UI from stored pipeline state (for loading chat history)
   */
  restoreFromState(timestamp?: string): void {
    if (!this.state) return;
    const id = this.responseCounter;

    // Mark all steps as complete
    for (let step = 1; step <= 4; step++) {
      const badge = document.getElementById(`step-badge-${step}-${id}`);
      if (badge) {
        badge.classList.remove('bg-secondary', 'bg-kea');
        badge.classList.add('bg-success');
      }
    }

    // Set progress to 100%
    const progress = document.getElementById(`pipeline-progress-${id}`);
    if (progress) {
      progress.style.width = '100%';
      progress.classList.add('bg-success');
    }

    // Helper function to render step content with ResponseRenderer
    const renderStepContent = (step: number, provider: string, data: Record<string, unknown>, confidence?: number) => {
      this.createProviderTab(step, provider);

      // Hide streaming, show rendered
      const streamingEl = document.getElementById(`step${step}-${provider}-streaming-${id}`);
      const renderedEl = document.getElementById(`step${step}-${provider}-rendered-${id}`);
      // Use raw_response if available (Step 2/3 preserve original text for proper parsing)
      const rawContent = typeof data.raw_response === 'string' ? data.raw_response : JSON.stringify(data, null, 2);

      if (streamingEl && renderedEl) {
        streamingEl.classList.add('d-none');
        renderedEl.classList.remove('d-none');
        renderedEl.innerHTML = ResponseRenderer.renderContainer(step, provider, rawContent, id, this.viewMode);
      }

      // Hide spinner and add success icon
      const spinner = document.getElementById(`step${step}-${provider}-spinner-${id}`);
      if (spinner) spinner.classList.add('d-none');

      const tab = document.getElementById(`step${step}-${provider}-tab-${id}`);
      if (tab) {
        tab.insertAdjacentHTML('beforeend', '<i class="bi bi-check-circle text-success ms-1"></i>');
        if (confidence !== undefined) {
          tab.insertAdjacentHTML('beforeend', `<span class="badge bg-info ms-1">${confidence.toFixed(2)}</span>`);
        }
      }
    };

    // Populate Step 1 tabs
    for (const provider of Object.keys(this.state.step1Responses)) {
      const data = this.state.step1Responses[provider];
      renderStepContent(1, provider, data, data.confidence);
    }

    // Populate Step 2 tabs
    for (const provider of Object.keys(this.state.step2Responses)) {
      const data = this.state.step2Responses[provider];
      renderStepContent(2, provider, data, data.confidence);
    }

    // Populate Step 3 tabs
    for (const provider of Object.keys(this.state.step3Responses)) {
      const data = this.state.step3Responses[provider];
      renderStepContent(3, provider, data);
    }

    // Populate Step 4 and show final answer
    if (this.state.step4Response) {
      const data = this.state.step4Response;
      renderStepContent(4, data.provider, data);

      // Show synthesizer info
      if (this.state.synthesizer) {
        const stepContent = document.getElementById(`step-content-4-${id}`);
        if (stepContent) {
          const synth = this.state.synthesizer;
          const config = PROVIDER_CONFIG[synth] || { name: synth, icon: 'bi-robot', color: '#6c757d' };
          const cached = getProviderCache()[synth];
          const displayName = cached?.display_name || config.name;
          const iconHtml = `<span>${getProviderIconHtml(synth)}</span>`;
          stepContent.insertAdjacentHTML(
            'afterbegin',
            `<div class="alert alert-info py-1 mb-2 small">
              <i class="bi bi-award me-1"></i>
              Synthesizer: ${iconHtml} <strong>${displayName}</strong> (ranked #1)
            </div>`
          );
        }
      }

      // Show final answer card
      this.onStep4Done(data.provider, data.final_answer, data.confidence, timestamp);
    }

    // Update step counts
    for (let step = 1; step <= 4; step++) {
      const countEl = document.getElementById(`step-count-${step}-${id}`);
      if (countEl) {
        let count = 0;
        if (step === 1) count = Object.keys(this.state.step1Responses).length;
        else if (step === 2) count = Object.keys(this.state.step2Responses).length;
        else if (step === 3) count = Object.keys(this.state.step3Responses).length;
        else if (step === 4 && this.state.step4Response) count = 1;
        countEl.textContent = String(count);
        countEl.classList.remove('bg-secondary');
        countEl.classList.add('bg-success');
      }
    }
  },

};

// Global export
declare global {
  interface Window {
    PipelineManager: typeof PipelineManager;
    MathJax?: {
      typesetPromise(elements?: HTMLElement[]): Promise<void>;
    };
  }
}

window.PipelineManager = PipelineManager;
