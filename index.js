import dotenv from 'dotenv';
import { request, gql } from 'graphql-request';
import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import mime from 'mime-types'; // Import mime-types library

dotenv.config();

// Shopify GraphQL endpoint
const endpoint = `https://${process.env.SHOPIFY_STORE_URL}/admin/api/${process.env.API_VERSION}/graphql.json`;

// Step 1: Generate a staged upload URL
async function generateStagedUploadUrl(filename, mimeType, fileSize) {
  const query = gql`
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

  const variables = {
    input: [
      {
        resource: 'IMAGE',
        filename,
        mimeType,
        fileSize: fileSize.toString(),
        httpMethod: 'POST',
      },
    ],
  };

  const headers = {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
  };

  try {
    const response = await request(endpoint, query, variables, headers);
    const { stagedTargets, userErrors } = response.stagedUploadsCreate;
    if (userErrors.length > 0) {
      throw new Error(userErrors[0].message);
    }
    console.log('Generated staged target:', stagedTargets[0]); // Log staged target for debugging
    return stagedTargets[0];
  } catch (error) {
    console.error("Error generating staged upload URL:", error.message);
    throw error;
  }
}

// Step 2: Upload the image using the staged upload URL
async function uploadImageToShopify(stagedTarget, filePath) {
  const formData = new FormData();

  // Append parameters first
  stagedTarget.parameters.forEach(({ name, value }) => {
    formData.append(name, value);
  });

  // Append the file
  formData.append('file', fs.createReadStream(filePath));

  try {
    // Use await for getLength() to resolve it asynchronously
    const contentLength = await new Promise((resolve, reject) => {
      formData.getLength((err, length) => {
        if (err) reject(err);
        resolve(length);
      });
    });

    const response = await axios.post(stagedTarget.url, formData, {
      headers: {
        ...formData.getHeaders(),
        'Content-Length': contentLength, // Use asynchronously resolved content length
      },
    });

    if (response.status !== 201) { // Note: Google expects 201 for success here, not 204
      console.error('Response data:', response.data); // Log response data for debugging
      throw new Error('Image upload failed');
    }

    return stagedTarget.resourceUrl;
  } catch (error) {
    console.error("Error uploading image:", error.message);
    if (error.response) {
      console.error("Error details:", error.response.data); // Log detailed error response
    }
    throw error;
  }
}

// Step 3: Get Product ID by Handle
async function getProductIdByHandle(handle) {
  const query = gql`
    {
      productByHandle(handle: "${handle}") {
        id
      }
    }
  `;

  const headers = {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
  };

  try {
    const response = await request(endpoint, query, {}, headers);
    if (response.productByHandle) {
      return response.productByHandle.id;
    } else {
      throw new Error(`Product with handle "${handle}" not found.`);
    }
  } catch (error) {
    console.error("Error fetching product ID:", error.message);
    throw error;
  }
}

// Step 4: Associate the image with a product
async function associateImageWithProduct(productId, resourceUrl, altText) {
  const query = gql`
    mutation productCreateMedia($media: [CreateMediaInput!]!, $productId: ID!) {
      productCreateMedia(media: $media, productId: $productId) {
        media {
          alt
          mediaContentType
          status
          id
        }
        mediaUserErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    productId,
    media: [
      {
        alt: altText,
        mediaContentType: 'IMAGE',
        originalSource: resourceUrl,
      },
    ],
  };

  const headers = {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
  };

  try {
    const response = await request(endpoint, query, variables, headers);
    const { mediaUserErrors, media } = response.productCreateMedia;

    if (mediaUserErrors.length > 0) {
      throw new Error(mediaUserErrors[0].message);
    }

    return media[0];
  } catch (error) {
    console.error("Error associating image with product:", error.message);
    throw error;
  }
}

// Step 5: Automate for Multiple Images with Product Handles from File Names
async function processImages() {
  const imagesFolderPath = './images';
  const imageFiles = fs.readdirSync(imagesFolderPath);

  for (const imageFile of imageFiles) {
    const filePath = path.join(imagesFolderPath, imageFile);
    const { size } = fs.statSync(filePath);
    
    // Detect the MIME type dynamically, although we know these are .jpg
    const mimeType = mime.lookup(filePath) || 'image/jpeg';
    const handle = path.basename(imageFile, path.extname(imageFile));

    try {
      // Get the product ID by handle
      const productId = await getProductIdByHandle(handle);

      // Continue with the upload and association process
      const stagedTarget = await generateStagedUploadUrl(imageFile, mimeType, size);
      const resourceUrl = await uploadImageToShopify(stagedTarget, filePath);
      const media = await associateImageWithProduct(productId, resourceUrl, handle);
      console.log(`Successfully added image ${imageFile} to product ${productId}`);
    } catch (error) {
      console.error(`Failed to process image ${imageFile}:`, error.message);
    }

    // Add a delay to respect Shopify's rate limits
    await new Promise(resolve => setTimeout(resolve, 1000)); // 1-second delay
  }
}

// Execute the process for all images
processImages();
