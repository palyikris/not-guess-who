/**
 * Image Compression Worker
 */
self.onmessage = async (
  e: MessageEvent<{ requestId: string; file: File; maxSize: number }>,
) => {
  const { requestId, file, maxSize } = e.data;

  try {
    const bitmap = await createImageBitmap(file);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");

    if (!ctx) {
      throw new Error("Could not get 2d context");
    }

    ctx.drawImage(bitmap, 0, 0);

    let quality = 0.9;
    let blob = await canvas.convertToBlob({ type: "image/jpeg", quality });

    // Iteratively reduce quality if size is still too large
    while (blob.size > maxSize && quality > 0.1) {
      quality -= 0.1;
      blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
    }

    // If still too large, resize
    if (blob.size > maxSize) {
      let scale = 0.8;
      while (blob.size > maxSize && scale > 0.1) {
        const newWidth = Math.floor(bitmap.width * scale);
        const newHeight = Math.floor(bitmap.height * scale);
        canvas.width = newWidth;
        canvas.height = newHeight;
        ctx.drawImage(bitmap, 0, 0, newWidth, newHeight);
        blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
        scale -= 0.1;
      }
    }

    const reader = new FileReader();
    reader.onloadend = () => {
      self.postMessage({ requestId, base64: reader.result, success: true });
    };
    reader.readAsDataURL(blob);
  } catch (error) {
    self.postMessage({
      requestId,
      success: false,
      error: (error as Error).message,
    });
  }
};
