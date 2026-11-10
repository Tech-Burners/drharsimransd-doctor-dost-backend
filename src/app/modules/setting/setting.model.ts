import mongoose, { Schema, Document } from "mongoose";

// Interface for Privacy Policy
export interface ISettings extends Document {
  content: string;
  key: "privacyPolicy"|"cookiesPolicy"|"termsAndConditions";
}

// Privacy Policy Schema
const settingsSchema = new Schema<ISettings>(
  {
    content: {
      type: String,
      required: true,
    },
    key: {
      type: String,
      enum: [ "privacyPolicy","cookiesPolicy","termsAndConditions" ], // enum ensures that only these values are valid
      required: true,
    },
  },
  { timestamps: true }
);


const Settings = mongoose.model<ISettings>("Settings", settingsSchema);

export default Settings;
