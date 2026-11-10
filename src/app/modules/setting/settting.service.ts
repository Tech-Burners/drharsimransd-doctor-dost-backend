import  Settings, { ISettings } from "./setting.model";


// Get the settings
const getSettingsByKey = async (payload: {key: "privacyPolicy"|"cookiesPolicy"|"termsAndConditions" }): Promise<ISettings | null> => {
    return await Settings.findOne(payload).sort({ createdAt: -1 });
};

// Create or update the privacy policy
const updateSettingsByKey = async (key: "privacyPolicy"|"cookiesPolicy"|"termsAndConditions", content: string): Promise<ISettings> => {
    let policy = await Settings.findOne({key});
    if (!policy) {
        policy = new Settings({key, content });
    } else {
        policy.content = content;
    }
    return await policy.save();
};

export const settingsService = {
    getSettingsByKey,
    updateSettingsByKey
};
