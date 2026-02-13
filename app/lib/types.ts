/**
 * Shared types for the Bulk Image Uploader
 */

export interface ShopifyProduct {
  id: string;
  handle: string;
  title: string;
  status: string;
  featuredImage: {
    url: string;
  } | null;
  media: {
    edges: Array<{
      node: {
        id: string;
        mediaContentType: string;
      };
    }>;
  };
}

export interface ImageFile {
  name: string;
  size: number;
  type: string;
  previewUrl?: string;
  file?: File; // The actual File object for upload
}

export interface StagedTarget {
  url: string;
  resourceUrl: string;
  parameters: Array<{ name: string; value: string }>;
  productId: string;
  filename: string;
}

export interface MatchResult {
  image: ImageFile;
  product: ShopifyProduct | null;
  matched: boolean;
  handle: string;
}

export interface MatchSummary {
  total: number;
  matched: number;
  unmatched: number;
  results: MatchResult[];
}

export interface UploadResult {
  filename: string;
  productId: string;
  success: boolean;
  error?: string;
}

export interface UploadSummary {
  total: number;
  succeeded: number;
  failed: number;
}
