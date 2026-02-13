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
      }
      mediaUserErrors {
        field
        message
      }
    }
  }
`;

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

  // Handle full server-side upload
  if (intent === "upload-file") {
    const file = formData.get("file") as File;
    const productId = formData.get("productId") as string;
    
    if (!file || !productId) {
      return { success: false, error: "Missing file or productId" };
    }

    try {
      // Step 1: Create staged upload target
      const stagedResponse = await admin.graphql(STAGED_UPLOADS_CREATE, {
        variables: {
          input: [{
            filename: file.name,
            mimeType: file.type || "image/png",
            fileSize: file.size.toString(),
            resource: "IMAGE",
          }],
        },
      });
      const stagedData = await stagedResponse.json();

      if (stagedData.data.stagedUploadsCreate.userErrors.length > 0) {
        return {
          success: false,
          error: stagedData.data.stagedUploadsCreate.userErrors
            .map((e: { message: string }) => e.message)
            .join(", "),
        };
      }

      const target = stagedData.data.stagedUploadsCreate.stagedTargets[0];
      
      // Step 2: Upload file to staged URL (server-side)
      const uploadFormData = new FormData();
      for (const param of target.parameters) {
        uploadFormData.append(param.name, param.value);
      }
      uploadFormData.append("file", file);

      const uploadResponse = await fetch(target.url, {
        method: "POST",
        body: uploadFormData,
      });

      if (!uploadResponse.ok) {
        const errorText = await uploadResponse.text();
        console.error("Staged upload failed:", errorText);
        return {
          success: false,
          error: `Upload failed: ${uploadResponse.status}`,
        };
      }

      // Step 3: Attach media to product
      const mediaResponse = await admin.graphql(PRODUCT_CREATE_MEDIA, {
        variables: {
          productId,
          media: [{
            originalSource: target.resourceUrl,
            mediaContentType: "IMAGE",
            alt: file.name.replace(/\.[^.]+$/, ""),
          }],
        },
      });
      const mediaData = await mediaResponse.json();

      if (mediaData.data.productCreateMedia.mediaUserErrors.length > 0) {
        return {
          success: false,
          error: mediaData.data.productCreateMedia.mediaUserErrors
            .map((e: { message: string }) => e.message)
            .join(", "),
        };
      }

      return {
        success: true,
        filename: file.name,
        productId,
      };
    } catch (error) {
      console.error("Upload error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Upload failed",
      };
    }
  }

  return { success: false, error: "Invalid intent" };
};
