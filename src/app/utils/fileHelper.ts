import path from 'path';
import fs from 'fs';


export const deleteFile = async (filePath: string) => {

  try {
    // normalize path to avoid double slashes
    const fullPath = path.join(__dirname, "../public", filePath.replace(/^\/+/, ''));

    if (fs.existsSync(fullPath)) {
      await fs.promises.unlink(fullPath);
      console.log("deleted:", fullPath);
    } else {
      console.log("not found:", fullPath);
    }
  } catch (err: any) {
    throw new Error(`Error deleting file: ${err.message}`);
  }
};

export const storeFile = (folderName: string, filename: string) => {
  return `/uploads/${folderName}/${filename}`;
};

// this is use for muiltiple fields file upload
export const storeFiles = (
  folderName: string,
  files: { [fieldName: string]: Express.Multer.File[] }
): { [fieldName: string]: string[] } => {
  if (!folderName || !files) {
    throw new Error('Both folderName and files are required.');
  }

  const sanitizedFolder = folderName.replace(/\/+$/, ''); // Remove trailing slashes
  const result: { [fieldName: string]: string[] } = {};

  // Use Object.entries to iterate over the files object
  Object.entries(files).forEach(([fieldName, fileArray]) => {
    // Map each file in the field to its generated path
    result[fieldName] = fileArray.map((file) => {
      const sanitizedFilename = file.filename.replace(/^\/+/, ''); // Remove leading slashes
      return `/uploads/${sanitizedFolder}/${sanitizedFilename}`;
    });
  });

  return result;
};