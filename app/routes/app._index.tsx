import React, { useCallback, useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  matchImagesToProducts,
  validateImageFile,
  SUPPORTED_EXTENSIONS,
} from "../lib/matching";
import type {
  ShopifyProduct,
  ImageFile,
  MatchResult,
  UploadResult,
  StagedTarget,
} from "../lib/types";

// GraphQL query to fetch draft products
const GET_DRAFT_PRODUCTS = `#graphql
  query GetDraftProducts($cursor: String) {
    products(first: 100, after: $cursor, query: "status:draft") {
      edges {
        node {
          id
          handle
          title
          status
          featuredImage {
            url
          }
          media(first: 1) {
            edges {
              node {
                id
                mediaContentType
              }
            }
          }
        }
        cursor
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// GraphQL mutation to upload image to product
const PRODUCT_CREATE_MEDIA = `#graphql
  mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media {
        id
      }
      mediaUserErrors {
        field
        message
      }
    }
  }
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  // Fetch all draft products with pagination
  const products: ShopifyProduct[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const response = await admin.graphql(GET_DRAFT_PRODUCTS, {
      variables: { cursor },
    });
    const data = await response.json();

    for (const edge of data.data.products.edges) {
      products.push(edge.node);
    }

    hasNextPage = data.data.products.pageInfo.hasNextPage;
    cursor = data.data.products.pageInfo.endCursor;
  }

  return { products };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const intent = formData.get("intent");

  if (intent === "upload") {
    const uploadsJson = formData.get("uploads") as string;
    const uploads: Array<{ productId: string; imageUrl: string; filename: string }> =
      JSON.parse(uploadsJson);

    const results: UploadResult[] = [];

    for (const upload of uploads) {
      try {
        const response = await admin.graphql(PRODUCT_CREATE_MEDIA, {
          variables: {
            productId: upload.productId,
            media: [
              {
                originalSource: upload.imageUrl,
                mediaContentType: "IMAGE",
                alt: upload.filename,
              },
            ],
          },
        });

        const data = await response.json();

        if (data.data.productCreateMedia.mediaUserErrors.length > 0) {
          const errors = data.data.productCreateMedia.mediaUserErrors
            .map((e: { message: string }) => e.message)
            .join(", ");
          results.push({
            filename: upload.filename,
            productId: upload.productId,
            success: false,
            error: errors,
          });
        } else {
          results.push({
            filename: upload.filename,
            productId: upload.productId,
            success: true,
          });
        }
      } catch (error) {
        results.push({
          filename: upload.filename,
          productId: upload.productId,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    return { results };
  }

  return null;
};

export default function Index() {
  const { products } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  // State
  const [images, setImages] = useState<ImageFile[]>([]);
  const [matchResults, setMatchResults] = useState<MatchResult[]>([]);
  const [uploadResults, setUploadResults] = useState<UploadResult[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [uploadProgress, setUploadProgress] = useState<string>("");
  const [isUploadingState, setIsUploadingState] = useState(false);

  const isUploading = fetcher.state === "submitting" || isUploadingState;

  // Update match results when images or products change
  useEffect(() => {
    if (images.length > 0 && products.length > 0) {
      const results = matchImagesToProducts(images, products);
      setMatchResults(results.results);
    } else {
      setMatchResults([]);
    }
  }, [images, products]);

  // Handle upload completion
  useEffect(() => {
    if (fetcher.data?.results) {
      setUploadResults(fetcher.data.results);
      const succeeded = fetcher.data.results.filter((r: UploadResult) => r.success).length;
      if (succeeded > 0) {
        shopify.toast.show(`Successfully uploaded ${succeeded} images`);
      }
    }
  }, [fetcher.data, shopify]);

  // Store files in a ref so we can access them during upload
  const fileMapRef = React.useRef<Map<string, File>>(new Map());

  const processFiles = useCallback((fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    const validFiles: ImageFile[] = [];
    const newErrors: string[] = [];

    for (const file of files) {
      const validation = validateImageFile(file);
      if (validation.valid) {
        // Store the file in the ref for later upload
        fileMapRef.current.set(file.name, file);
        validFiles.push({
          name: file.name,
          size: file.size,
          type: file.type,
          previewUrl: URL.createObjectURL(file),
          file: file,
        });
      } else {
        newErrors.push(`${file.name}: ${validation.error}`);
      }
    }

    if (newErrors.length > 0) {
      setErrors(newErrors);
      setTimeout(() => setErrors([]), 5000);
    }

    if (validFiles.length > 0) {
      setImages((prev) => {
        const existingNames = new Set(prev.map((f) => f.name));
        const uniqueNewFiles = validFiles.filter((f) => !existingNames.has(f.name));
        return [...prev, ...uniqueNewFiles];
      });
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files?.length) {
        processFiles(e.dataTransfer.files);
      }
    },
    [processFiles]
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files?.length) {
        processFiles(e.target.files);
        e.target.value = "";
      }
    },
    [processFiles]
  );

  const handleRemoveImage = useCallback((imageName: string) => {
    setImages((prev) => prev.filter((f) => f.name !== imageName));
  }, []);

  const handleClearAll = useCallback(() => {
    images.forEach((img) => {
      if (img.previewUrl) {
        URL.revokeObjectURL(img.previewUrl);
      }
    });
    setImages([]);
    setMatchResults([]);
    setUploadResults([]);
  }, [images]);

  const handleUpload = useCallback(async () => {
    const matched = matchResults.filter((r) => r.matched && r.product);
    if (matched.length === 0) return;

    setIsUploadingState(true);
    setUploadProgress("Preparing uploads...");
    setUploadResults([]);

    try {
      // Step 1: Get staged upload URLs from Shopify
      const uploadRequests = matched.map((r) => ({
        productId: r.product!.id,
        filename: r.image.name,
        mimeType: r.image.type || "image/png",
        fileSize: r.image.size,
      }));

      const stagedResponse = await fetch("/app/api/upload", {
        method: "POST",
        body: new URLSearchParams({
          intent: "get-upload-urls",
          uploads: JSON.stringify(uploadRequests),
        }),
      });
      const stagedData = await stagedResponse.json();

      if (!stagedData.success) {
        throw new Error(stagedData.error || "Failed to get upload URLs");
      }

      const targets: StagedTarget[] = stagedData.targets;
      const successfulUploads: Array<{ productId: string; resourceUrl: string; filename: string }> = [];

      // Step 2: Upload each file to Shopify's staged URL
      for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        const file = fileMapRef.current.get(target.filename);

        if (!file) {
          console.error(`File not found: ${target.filename}`);
          continue;
        }

        setUploadProgress(`Uploading ${i + 1} of ${targets.length}: ${target.filename}`);

        try {
          // Create form data with all parameters
          const uploadFormData = new FormData();
          for (const param of target.parameters) {
            uploadFormData.append(param.name, param.value);
          }
          uploadFormData.append("file", file);

          // Upload to the staged URL
          const uploadResponse = await fetch(target.url, {
            method: "POST",
            body: uploadFormData,
          });

          if (uploadResponse.ok) {
            successfulUploads.push({
              productId: target.productId,
              resourceUrl: target.resourceUrl,
              filename: target.filename,
            });
          } else {
            console.error(`Failed to upload ${target.filename}:`, await uploadResponse.text());
          }
        } catch (uploadError) {
          console.error(`Error uploading ${target.filename}:`, uploadError);
        }
      }

      // Step 3: Attach uploaded media to products
      if (successfulUploads.length > 0) {
        setUploadProgress("Attaching images to products...");

        const attachResponse = await fetch("/app/api/upload", {
          method: "POST",
          body: new URLSearchParams({
            intent: "attach-media",
            attachments: JSON.stringify(successfulUploads),
          }),
        });
        const attachData = await attachResponse.json();

        if (attachData.results) {
          setUploadResults(attachData.results);
          const succeeded = attachData.results.filter((r: UploadResult) => r.success).length;
          const failed = attachData.results.filter((r: UploadResult) => !r.success).length;

          if (succeeded > 0) {
            shopify.toast.show(`Successfully uploaded ${succeeded} images${failed > 0 ? `, ${failed} failed` : ""}`);
            
            // Remove successfully uploaded images from the list
            const successfulFilenames = new Set(
              attachData.results
                .filter((r: UploadResult) => r.success)
                .map((r: UploadResult) => r.filename)
            );
            setImages((prev) => prev.filter((img) => !successfulFilenames.has(img.name)));
          } else if (failed > 0) {
            shopify.toast.show(`Failed to upload ${failed} images`, { isError: true });
          }
        }
      } else {
        shopify.toast.show("No images were uploaded successfully", { isError: true });
      }
    } catch (error) {
      console.error("Upload error:", error);
      shopify.toast.show(
        error instanceof Error ? error.message : "Upload failed",
        { isError: true }
      );
    } finally {
      setIsUploadingState(false);
      setUploadProgress("");
    }
  }, [matchResults, shopify]);

  const matchedCount = matchResults.filter((r) => r.matched).length;

  return (
    <s-page heading="Bulk Image Uploader">
      {/* Stats Section */}
      <s-section>
        <s-stack direction="inline" gap="loose">
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <s-stack direction="block" gap="tight">
              <s-text variant="bodyMd" tone="subdued">
                Draft Products
              </s-text>
              <s-text variant="headingLg">{products.length}</s-text>
            </s-stack>
          </s-box>
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <s-stack direction="block" gap="tight">
              <s-text variant="bodyMd" tone="subdued">
                Images Added
              </s-text>
              <s-text variant="headingLg">{images.length}</s-text>
            </s-stack>
          </s-box>
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <s-stack direction="block" gap="tight">
              <s-text variant="bodyMd" tone="subdued">
                Matched
              </s-text>
              <s-text variant="headingLg" tone="success">
                {matchedCount} / {images.length}
              </s-text>
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>

      {/* Dropzone */}
      <s-section heading="Upload Images">
        <div
          onDragEnter={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setIsDragging(false);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          style={{
            border: `2px dashed ${isDragging ? "#008060" : "#c9cccf"}`,
            borderRadius: "8px",
            padding: "40px",
            textAlign: "center",
            backgroundColor: isDragging ? "#f1f8f5" : "#fafbfb",
            cursor: "pointer",
            position: "relative",
          }}
        >
          <input
            type="file"
            multiple
            accept={SUPPORTED_EXTENSIONS.join(",")}
            onChange={handleFileInput}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              opacity: 0,
              cursor: "pointer",
            }}
          />
          <s-stack direction="block" gap="base" align="center">
            <s-icon name="ImageIcon" />
            <s-text variant="headingSm">
              {isDragging ? "Drop images here" : "Drag and drop product images"}
            </s-text>
            <s-text variant="bodySm" tone="subdued">
              or click to browse. Supports PNG, JPG, WEBP, GIF (max 20MB each)
            </s-text>
            <s-text variant="bodySm" tone="subdued">
              Name images with the product handle (e.g., blue-widget.png)
            </s-text>
          </s-stack>
        </div>
      </s-section>

      {/* Errors */}
      {errors.length > 0 && (
        <s-section>
          <s-banner tone="critical" onDismiss={() => setErrors([])}>
            <s-text variant="bodyMd">Some files could not be added:</s-text>
            <s-unordered-list>
              {errors.map((error, i) => (
                <s-list-item key={i}>{error}</s-list-item>
              ))}
            </s-unordered-list>
          </s-banner>
        </s-section>
      )}

      {/* Upload Progress */}
      {uploadProgress && (
        <s-section>
          <s-banner tone="info">
            <s-stack direction="inline" gap="base" align="center">
              <s-spinner size="small" />
              <s-text variant="bodyMd">{uploadProgress}</s-text>
            </s-stack>
          </s-banner>
        </s-section>
      )}

      {/* Upload Results */}
      {uploadResults.length > 0 && !uploadProgress && (
        <s-section>
          <s-banner
            tone={
              uploadResults.every((r) => r.success) ? "success" : "warning"
            }
          >
            <s-text variant="bodyMd">
              Uploaded {uploadResults.filter((r) => r.success).length} of{" "}
              {uploadResults.length} images
            </s-text>
            {uploadResults.some((r) => !r.success) && (
              <s-unordered-list>
                {uploadResults
                  .filter((r) => !r.success)
                  .map((r, i) => (
                    <s-list-item key={i}>
                      {r.filename}: {r.error}
                    </s-list-item>
                  ))}
              </s-unordered-list>
            )}
          </s-banner>
        </s-section>
      )}

      {/* Match Results Table */}
      {images.length > 0 && (
        <s-section heading="Image Matches">
          <s-stack direction="inline" gap="base" style={{ marginBottom: "16px" }}>
            <s-button onClick={handleClearAll} variant="tertiary">
              Clear All
            </s-button>
            <s-button
              onClick={handleUpload}
              variant="primary"
              disabled={matchedCount === 0 || isUploading}
              {...(isUploading ? { loading: true } : {})}
            >
              Upload {matchedCount} Images
            </s-button>
          </s-stack>

          <s-data-table>
            <s-data-table-header>
              <s-data-table-row>
                <s-data-table-heading>Filename</s-data-table-heading>
                <s-data-table-heading>Handle</s-data-table-heading>
                <s-data-table-heading>Product</s-data-table-heading>
                <s-data-table-heading>Status</s-data-table-heading>
                <s-data-table-heading>Actions</s-data-table-heading>
              </s-data-table-row>
            </s-data-table-header>
            <s-data-table-body>
              {matchResults.map((result) => (
                <s-data-table-row key={result.image.name}>
                  <s-data-table-cell>
                    <s-stack direction="block" gap="tight">
                      <s-text variant="bodyMd">{result.image.name}</s-text>
                      <s-text variant="bodySm" tone="subdued">
                        {(result.image.size / 1024 / 1024).toFixed(2)} MB
                      </s-text>
                    </s-stack>
                  </s-data-table-cell>
                  <s-data-table-cell>
                    <s-text variant="bodyMd" tone="subdued">
                      {result.handle}
                    </s-text>
                  </s-data-table-cell>
                  <s-data-table-cell>
                    {result.product ? (
                      <s-text variant="bodyMd">{result.product.title}</s-text>
                    ) : (
                      <s-text variant="bodyMd" tone="subdued">
                        No match found
                      </s-text>
                    )}
                  </s-data-table-cell>
                  <s-data-table-cell>
                    {result.matched ? (
                      <s-badge tone="success">Matched</s-badge>
                    ) : (
                      <s-badge tone="critical">Unmatched</s-badge>
                    )}
                  </s-data-table-cell>
                  <s-data-table-cell>
                    <s-button
                      variant="tertiary"
                      tone="critical"
                      onClick={() => handleRemoveImage(result.image.name)}
                    >
                      Remove
                    </s-button>
                  </s-data-table-cell>
                </s-data-table-row>
              ))}
            </s-data-table-body>
          </s-data-table>
        </s-section>
      )}

      {/* Empty State */}
      {images.length === 0 && products.length > 0 && (
        <s-section>
          <s-box padding="loose" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="base" align="center">
              <s-text variant="bodyMd" tone="subdued">
                Found <strong>{products.length}</strong> draft products.
              </s-text>
              <s-text variant="bodySm" tone="subdued">
                Drop images named with product handles to match and upload them.
              </s-text>
            </s-stack>
          </s-box>
        </s-section>
      )}

      {/* Help Section */}
      <s-section slot="aside" heading="How it works">
        <s-unordered-list>
          <s-list-item>
            Name your images with the product handle (e.g., blue-widget.png)
          </s-list-item>
          <s-list-item>
            Drop images here to automatically match them to products
          </s-list-item>
          <s-list-item>
            Review matches and click Upload to add images to products
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="Supported formats">
        <s-text variant="bodySm" tone="subdued">
          PNG, JPG, JPEG, WEBP, GIF (max 20MB each)
        </s-text>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
