import fs from "fs";
import path from "path";

export const deleteFile = (relativePath: string) => {
  try {
    if (!relativePath) return;

    const filePath = path.join(process.cwd(), "public", relativePath);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`🗑️ Deleted file: ${relativePath}`);
    }
  } catch (err) {
    console.error(`Failed to delete file ${relativePath}:`, err);
  }
};
