import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// GraphQL mutation to create staged upload targets
const STAGED_UPLOADS_CREATE = `#graphql
  mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters {
          name
          value
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// GraphQL mutation to attach media to product
const PRODUCT_CREATE_MEDIA = `#graphql
  mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media {
        id
        ... on MediaImage {
          image {
            url
          }
        }
      }
      mediaUserErrors {
        field
        message
      }
    }
  }
`;

interface UploadRequest {
  productId: string;
  filename: string;
  mimeType: string;
  fileSize: number;
}

interface UploadResult {
  filename: string;
  productId: string;
  success: boolean;
  error?: string;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "get-upload-urls") {
    // Step 1: Get staged upload URLs from Shopify
    const uploadsJson = formData.get("uploads") as string;
    const uploads: UploadRequest[] = JSON.parse(uploadsJson);

    const stagedInput = uploads.map((u) => ({
      filename: u.filename,
      mimeType: u.mimeType,
      fileSize: u.fileSize.toString(),
      resource: "IMAGE" as const,
    }));

    try {
      const response = await admin.graphql(STAGED_UPLOADS_CREATE, {
        variables: { input: stagedInput },
      });
      const data = await response.json();

      if (data.data.stagedUploadsCreate.userErrors.length > 0) {
        return {
          success: false,
          error: data.data.stagedUploadsCreate.userErrors
            .map((e: { message: string }) => e.message)
            .join(", "),
        };
      }

      // Return the staged targets with their corresponding product IDs
      const targets = data.data.stagedUploadsCreate.stagedTargets.map(
        (target: { url: string; resourceUrl: string; parameters: Array<{ name: string; value: string }> }, index: number) => ({
          ...target,
          productId: uploads[index].productId,
          filename: uploads[index].filename,
        })
      );

      return { success: true, targets };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create staged uploads",
      };
    }
  }

  if (intent === "attach-media") {
    // Step 3: Attach uploaded images to products
    const attachmentsJson = formData.get("attachments") as string;
    const attachments: Array<{ productId: string; resourceUrl: string; filename: string }> =
      JSON.parse(attachmentsJson);

    const results: UploadResult[] = [];

    for (const attachment of attachments) {
      try {
        const response = await admin.graphql(PRODUCT_CREATE_MEDIA, {
          variables: {
            productId: attachment.productId,
            media: [
              {
                originalSource: attachment.resourceUrl,
                mediaContentType: "IMAGE",
                alt: attachment.filename.replace(/\.[^.]+$/, ""), // Remove extension for alt text
              },
            ],
          },
        });

        const data = await response.json();

        if (data.data.productCreateMedia.mediaUserErrors.length > 0) {
          results.push({
            filename: attachment.filename,
            productId: attachment.productId,
            success: false,
            error: data.data.productCreateMedia.mediaUserErrors
              .map((e: { message: string }) => e.message)
              .join(", "),
          });
        } else {
          results.push({
            filename: attachment.filename,
            productId: attachment.productId,
            success: true,
          });
        }
      } catch (error) {
        results.push({
          filename: attachment.filename,
          productId: attachment.productId,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    return { success: true, results };
  }

  return { success: false, error: "Invalid intent" };
};
