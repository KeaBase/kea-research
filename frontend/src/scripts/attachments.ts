/**
 * Attachment Manager
 */

import { StorageUtils } from './storage';
import { ImageCompressor } from './image';
import { fileTypeFromBlob } from 'file-type';

declare function t(key: string, vars?: Record<string, string | number>): string;

interface Attachment {
  type: 'image' | 'file' | 'youtube' | 'wikipedia';
  file?: File;              // Keep for images
  url?: string;             // Keep for youtube/wikipedia
  name?: string;

  // For text-based files
  textContent?: string;     // Extracted UTF-8 text
  extension?: string;       // e.g., "py", "json", "txt"
  sizeBytes?: number;       // Original file size
}

// File limits
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB per file
const MAX_TOTAL_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB total (all files combined)

// Supported text file extensions
const SUPPORTED_TEXT_EXTENSIONS = [
  // Programming languages
  'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'rb', 'php', 'cs', 'go', 'rs', 'c', 'cpp', 'h', 'hpp',
  // Shell scripts
  'sh', 'bash',
  // Web files
  'html', 'css', 'scss', 'sass', 'vue', 'svelte',
  // Config & data files
  'json', 'yaml', 'yml', 'toml', 'ini', 'env',
  'csv', 'xml', 'sql',
  // Documentation
  'md', 'mdx', 'txt', 'log'
];

export const AttachmentManager = {
  attachments: [] as Attachment[],
  useSearch: false,
  useDatabase: false,
  compressImages: true,
  compressionOptions: { quality: 85, maxWidthOrHeight: 2048 },

  async init(): Promise<void> {
    const settings = await StorageUtils.getSettings();
    this.compressImages = settings.compressAttachedImages;
    this.compressionOptions = {
      quality: settings.compressionQuality,
      maxWidthOrHeight: settings.compressionMaxDimension
    };

    const compressToggle = document.getElementById('compressAttachedImagesToggle') as HTMLInputElement | null;
    if (compressToggle) {
      compressToggle.addEventListener('change', (e) => {
        this.compressImages = (e.target as HTMLInputElement).checked;
      });
    }

    const qualitySlider = document.getElementById('compressionQuality') as HTMLInputElement | null;
    if (qualitySlider) {
      qualitySlider.addEventListener('input', (e) => {
        this.compressionOptions.quality = parseInt((e.target as HTMLInputElement).value);
      });
    }

    const dimensionSlider = document.getElementById('compressionMaxDimension') as HTMLInputElement | null;
    if (dimensionSlider) {
      dimensionSlider.addEventListener('input', (e) => {
        this.compressionOptions.maxWidthOrHeight = parseInt((e.target as HTMLInputElement).value);
      });
    }

    // === Wire up image attachment button ===
    const attachImageBtn = document.getElementById('attachImage');
    const imageInput = document.getElementById('imageInput') as HTMLInputElement | null;

    if (attachImageBtn && imageInput) {
      // Click button -> trigger file input
      attachImageBtn.addEventListener('click', () => {
        imageInput.click();
      });

      // File input change -> process selected files
      imageInput.addEventListener('change', async (e) => {
        const files = (e.target as HTMLInputElement).files;
        if (!files || files.length === 0) return;

        for (const file of Array.from(files)) {
          if (file.type.startsWith('image/')) {
            await this.addAttachment('image', file);
          } else {
            console.warn(`Skipping non-image file: ${file.name}`);
          }
        }

        // Reset input to allow selecting same file again
        imageInput.value = '';
      });
    }

    // === Wire up file attachment button ===
    const attachFileBtn = document.getElementById('attachFile');
    const fileInput = document.getElementById('fileInput') as HTMLInputElement | null;

    if (attachFileBtn && fileInput) {
      // Click button -> trigger file input
      attachFileBtn.addEventListener('click', () => {
        fileInput.click();
      });

      // File input change -> process selected files
      fileInput.addEventListener('change', async (e) => {
        const files = (e.target as HTMLInputElement).files;
        if (!files || files.length === 0) return;

        for (let i = 0; i < files.length; i++) {
          await this.addAttachment('file', files[i]);
        }

        // Reset input
        fileInput.value = '';
      });
    }

    console.log('AttachmentManager initialized (images + files enabled)');
  },

  updateIndicator(): void {
    const plusIcon = document.querySelector('#chatInputWrapper .dropdown .btn i');
    if (!plusIcon) return;

    if (this.useDatabase && this.useSearch) {
      plusIcon.className = 'bi bi-stars fs-5 text-kea';
    } else if (this.useDatabase) {
      plusIcon.className = 'bi bi-database fs-5 text-info';
    } else if (this.useSearch) {
      plusIcon.className = 'bi bi-search fs-5 text-warning';
    } else {
      plusIcon.className = 'bi bi-plus-circle fs-5';
    }
  },

  async addAttachment(type: 'image' | 'file', file: File): Promise<void> {
    // Handle file attachment
    if (type === 'file') {
      const extension = this.getFileExtension(file.name);

      // Validate extension
      if (!this.isSupportedTextFile(extension)) {
        alert(`Unsupported file type: .${extension}\nSupported: .py, .js, .json, .txt, .csv, .md, etc.`);
        return;
      }

      // Content-based file type detection using file-type library
      const detectedType = await fileTypeFromBlob(file);

      // If file-type detected a specific binary format, reject it
      if (detectedType) {
        alert(`This file appears to be a ${detectedType.ext} file (${detectedType.mime}), not text.\nPlease attach text files only.`);
        return;
      }

      // Additional MIME type check for files with detected MIME types
      if (file.type && !this.isTextMimeType(file.type)) {
        alert(`This file appears to be binary (${file.type}), not text.\nPlease attach text files only.`);
        return;
      }

      // Validate file size
      if (file.size > MAX_FILE_SIZE_BYTES) {
        alert(`File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB. Maximum is 10MB.`);
        return;
      }

      // Check total file size across all files
      const currentTotalSize = this.attachments
        .filter(a => a.type === 'file')
        .reduce((sum, a) => sum + (a.file?.size || 0), 0);

      if (currentTotalSize + file.size > MAX_TOTAL_FILE_SIZE_BYTES) {
        alert(`Maximum total file size is ${MAX_TOTAL_FILE_SIZE_BYTES / 1024 / 1024}MB. Please remove some files first.`);
        return;
      }

      // Store File object (text will be extracted at send time)
      this.attachments.push({
        type: 'file',
        file: file,
        name: file.name,
      });

      this.updateAttachmentPreview();

      return;
    }

    // Validate image type
    if (type === 'image') {
      const SUPPORTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
      if (SUPPORTED_TYPES.indexOf(file.type) === -1) {
        alert(`Unsupported image format: ${file.type}. Please use JPEG, PNG, WebP, or GIF.`);
        return;
      }

      // Check file size (max 10MB before compression)
      const MAX_SIZE_BYTES = 10 * 1024 * 1024;
      if (file.size > MAX_SIZE_BYTES) {
        alert(`Image too large: ${(file.size / 1024 / 1024).toFixed(1)}MB. Maximum is 10MB.`);
        return;
      }

      // Limit: 8 images per message (Mistral's API limit, https://docs.mistral.ai/capabilities/vision )
      const MAX_IMAGES = 8;
      const currentImageCount = this.attachments.filter((att) => att.type === 'image').length;
      if (currentImageCount >= MAX_IMAGES) {
        alert(`Maximum ${MAX_IMAGES} images per message. Please remove some images first.`);
        return;
      }
    }

    let processedFile = file;

    // Compress image if enabled
    if (type === 'image' && this.compressImages && file.type.startsWith('image/')) {
      try {
        console.log(`Compressing: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);

        const compressedBlob = await ImageCompressor.compressAttachment(
          file,
          this.compressionOptions
        );

        // Only use compressed if it's actually smaller
        if (compressedBlob.size < file.size) {
          processedFile = new File([compressedBlob], file.name, { type: compressedBlob.type });
          console.log(
            `Compressed: ${file.name} - ${(file.size / 1024).toFixed(1)}KB → ${(processedFile.size / 1024).toFixed(1)}KB`
          );
        } else {
          console.warn(`Compression increased size for ${file.name}, using original`);
        }
      } catch (error) {
        console.error('Compression failed, using original:', error);
        // Continue with original file
      }
    }

    // Add to attachments array
    this.attachments.push({
      type,
      file: processedFile,
      name: file.name,
    });

    // Update UI preview
    this.updateAttachmentPreview();
  },

  addYoutubeLink(url: string): void {
    this.attachments.push({ type: 'youtube', url });
    this.updateAttachmentPreview();
  },

  addWikipediaLink(url: string): void {
    this.attachments.push({ type: 'wikipedia', url });
    this.updateAttachmentPreview();
  },

  updateAttachmentPreview(): void {
    const previewContainer = document.getElementById('attachmentPreview');
    if (!previewContainer) return;

    if (this.attachments.length === 0) {
      previewContainer.innerHTML = '';
      previewContainer.classList.add('d-none');
      return;
    }

    previewContainer.classList.remove('d-none');

    const previewHTML = this.attachments
      .map((att, index) => {
        let preview = '';

        // Show thumbnail for images
        if (att.type === 'image' && att.file) {
          const imgUrl = URL.createObjectURL(att.file);
          preview = `
            <img
              src="${imgUrl}"
              class="img-thumbnail me-2 attachment-preview-thumbnail"
              alt="${att.name}"
            >
          `;

          // Clean up object URL after a delay
          setTimeout(() => URL.revokeObjectURL(imgUrl), 60000);
        }
        // Show icon for files
        else if (att.type === 'file' && att.file) {
          const extension = this.getFileExtension(att.file.name);
          const iconClass = this.getFileIcon(extension);
          const sizeKB = (att.file.size / 1024).toFixed(1);
          preview = `
            <div class="d-flex align-items-center">
              <i class="${iconClass} fs-4 me-2 text-primary"></i>
              <div class="small">
                <div class="text-body">${att.name}</div>
                <div class="text-muted">${sizeKB} KB</div>
              </div>
            </div>
          `;
        }
        else {
          preview = '<i class="bi bi-paperclip"></i>';
        }

        return `
          <div class="d-inline-flex align-items-center rounded px-2 py-1 me-2 mb-2 attachment-preview-item">
            ${preview}
            <button
              type="button"
              class="btn-close attachment-preview-close ms-2"
              aria-label="Remove"
              data-attachment-index="${index}"
            ></button>
          </div>
        `;
      })
      .join('');

    previewContainer.innerHTML = previewHTML;

    // Wire up remove buttons
    previewContainer.querySelectorAll('.btn-close').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const index = parseInt(target.dataset.attachmentIndex || '0', 10);
        this.removeAttachment(index);
      });
    });
  },

  removeAttachment(index: number): void {
    this.attachments.splice(index, 1);
    this.updateAttachmentPreview();
  },

  /**
   * Convert image file to base64 data URL
   * @param file Image file
   * @returns Promise resolving to base64 data URL (e.g., "data:image/jpeg;base64,...")
   */
  async convertImageToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result);
        } else {
          reject(new Error('FileReader result is not a string'));
        }
      };

      reader.onerror = () => {
        reject(reader.error || new Error('FileReader error'));
      };

      reader.readAsDataURL(file);
    });
  },

  showYoutubeModal(): void {
    const url = prompt(t('js.enterYoutubeUrl'));
    if (url && (url.includes('youtube.com') || url.includes('youtu.be'))) {
      this.addYoutubeLink(url);
    } else if (url) {
      alert(t('js.invalidYoutubeUrl'));
    }
  },

  showWikipediaModal(): void {
    const url = prompt(t('js.enterWikipediaUrl'));
    if (url && url.includes('wikipedia.org')) {
      this.addWikipediaLink(url);
    } else if (url) {
      alert(t('js.invalidWikipediaUrl'));
    }
  },

  /**
   * Clear all attachments (called after message is sent)
   */
  clearAttachments(): void {
    this.attachments = [];
    this.updateAttachmentPreview();
  },

  /**
   * Get file extension from filename
   */
  getFileExtension(filename: string): string {
    const parts = filename.split('.');
    return parts.length > 1 ? parts.pop()!.toLowerCase() : '';
  },

  /**
   * Check if file extension is supported for text extraction
   */
  isSupportedTextFile(extension: string): boolean {
    return SUPPORTED_TEXT_EXTENSIONS.indexOf(extension) !== -1;
  },

  /**
   * Check if MIME type indicates a text file (safe to read as UTF-8)
   */
  isTextMimeType(mimeType: string): boolean {
    const SAFE_TEXT_MIME_TYPES = [
      'text/plain',
      'text/html',
      'text/css',
      'text/javascript',
      'text/csv',
      'text/xml',
      'text/markdown',
      'application/json',
      'application/xml',
      'application/x-yaml',
      'text/x-yaml',
      'application/javascript',
      'application/x-sh'
    ];

    // Check if MIME type starts with "text/" or is in our safe list
    if (mimeType.indexOf('text/') === 0) {
      return true;
    }

    return SAFE_TEXT_MIME_TYPES.indexOf(mimeType) !== -1;
  },

  /**
   * Get Bootstrap icon class for file extension
   */
  getFileIcon(extension: string): string {
    // Bootstrap Icons has filetype icons for these extensions
    const KNOWN_ICONS = [
      'cs', 'java', 'js', 'jsx', 'php', 'py', 'rb', 'sh', 'tsx',
      'css', 'html', 'sass', 'scss',
      'csv', 'json', 'md', 'sql', 'txt', 'xml', 'yml', 'yaml',
      'ts', 'go', 'rs', 'c', 'cpp', 'vue'
    ];

    if (KNOWN_ICONS.indexOf(extension) !== -1) {
      return `bi bi-filetype-${extension}`;
    }
    return 'bi bi-file-earmark-code'; // Generic code file icon
  }
};

// Make it globally available
declare global {
  interface Window {
    AttachmentManager: typeof AttachmentManager;
  }
}

window.AttachmentManager = AttachmentManager;
