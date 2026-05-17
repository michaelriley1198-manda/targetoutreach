import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';

const CACHE_DIR = path.resolve('audio_cache');

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

export function audioPathForLead(leadId) {
  return path.join(CACHE_DIR, `${leadId}.mp3`);
}

export function audioFileExists(leadId) {
  return fs.existsSync(audioPathForLead(leadId));
}

export function announcePathForLead(leadId) {
  return path.join(CACHE_DIR, `announce_${leadId}.mp3`);
}

export function announceFileExists(leadId) {
  return fs.existsSync(announcePathForLead(leadId));
}

export function renderScript(template, vars) {
  if (!template) return '';
  return template.replace(/\[(\w+)\]/g, (_, key) => {
    const k = key.toUpperCase();
    return vars[k] != null ? String(vars[k]) : '';
  });
}

async function synthesizeMp3(targetPath, text) {
  ensureCacheDir();
  if (fs.existsSync(targetPath)) return targetPath;

  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const { data } = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    },
    {
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      responseType: 'arraybuffer',
      timeout: 60_000,
    }
  );

  fs.writeFileSync(targetPath, Buffer.from(data));
  return targetPath;
}

export const MY_NAME_AUDIO_PATH = path.join(path.resolve('audio_cache'), 'my_name.mp3');

export async function synthesizeMyName(text) {
  return synthesizeMp3(MY_NAME_AUDIO_PATH, text);
}

export async function synthesizeVoicemail(leadId, text) {
  return synthesizeMp3(audioPathForLead(leadId), text);
}

// Pre-roll clip played to the operator's headset before each dial: "Now ringing
// {first} {last}, {title} at {company} in {city, state}." Cached separately
// from the voicemail clip so the same lead can have both. Skip if the lead
// lacks the data we'd need for a useful announcement.
export async function synthesizeAnnouncement(leadId, lead) {
  const first = (lead.contact_name || '').split(' ')[0] || null;
  const last = (lead.contact_name || '').split(' ').slice(1).join(' ') || null;
  const company = lead.company_name || null;
  if (!company && !first) return null;

  const who = [first, last].filter(Boolean).join(' ');
  const title = lead.contact_title ? `, ${lead.contact_title}` : '';
  const at = company ? ` at ${company}` : '';
  const where = lead.location ? ` in ${lead.location}` : '';
  const text = `Now ringing ${who || 'unknown contact'}${title}${at}${where}.`.replace(/\s+/g, ' ').trim();

  return synthesizeMp3(announcePathForLead(leadId), text);
}
