/**
 * Image-to-Product Matching Logic
 * Matches uploaded images to Shopify products by comparing filenames to handles
 */

import type { ShopifyProduct, ImageFile, MatchResult, MatchSummary } from './types';

/**
 * Supported image extensions
 */
export const SUPPORTED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

/**
 * Maximum file size (20MB - Shopify's limit)
 */
export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

/**
 * Extract the handle from an image filename
 * Removes the file extension and normalizes the name
 */
export function extractHandleFromFilename(filename: string): string {
  const extensionPattern = new RegExp(`(${SUPPORTED_EXTENSIONS.join('|')})$`, 'i');
  return filename.replace(extensionPattern, '').toLowerCase();
}

/**
 * Validate an image file
 */
export function validateImageFile(file: { name: string; size: number }): { valid: boolean; error?: string } {
  const extension = '.' + file.name.split('.').pop()?.toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(extension)) {
    return {
      valid: false,
      error: `Unsupported file type: ${extension}. Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`,
    };
  }
  
  if (file.size > MAX_FILE_SIZE_BYTES) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    return {
      valid: false,
      error: `File too large: ${sizeMB}MB. Maximum: 20MB`,
    };
  }
  
  return { valid: true };
}

/**
 * Match images to products by comparing filenames to handles
 */
export function matchImagesToProducts(
  images: ImageFile[],
  products: ShopifyProduct[]
): MatchSummary {
  const productsByHandle = new Map<string, ShopifyProduct>();
  for (const product of products) {
    productsByHandle.set(product.handle.toLowerCase(), product);
  }
  
  const results: MatchResult[] = [];
  let matchedCount = 0;
  
  for (const image of images) {
    const handle = extractHandleFromFilename(image.name);
    const product = productsByHandle.get(handle) || null;
    const matched = product !== null;
    
    if (matched) {
      matchedCount++;
    }
    
    results.push({
      image,
      product,
      matched,
      handle,
    });
  }
  
  return {
    total: images.length,
    matched: matchedCount,
    unmatched: images.length - matchedCount,
    results,
  };
}

/**
 * Group match results by status for display
 */
export function groupMatchResults(results: MatchResult[]): {
  matched: MatchResult[];
  unmatched: MatchResult[];
} {
  return {
    matched: results.filter(r => r.matched),
    unmatched: results.filter(r => !r.matched),
  };
}
