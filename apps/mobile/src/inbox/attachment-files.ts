/** Files on the device. Everything goes under the connection's own folder, which signing out deletes. */
import type { ApiClient, Attachment } from '@openchat/api-client';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import { connectionFiles, connections } from '../connections/native';
import { isPrivateCopy, localFileName, localFolderName, MAX_UPLOAD_BYTES, PICKABLE_TYPES, uploadFileName } from './attachment-rules';

const stillSignedIn = (connectionId: string) => connections.getState().connections.some((connection) => connection.id === connectionId);

/** Fetches a file once, and returns where it is on the device. */
export async function localCopy(api: ApiClient, connectionId: string, file: Pick<Attachment, 'id' | 'filename' | 'size' | 'url'>): Promise<string> {
  const folder = new Directory(connectionFiles(connectionId), 'attachments', localFolderName(file.id));
  const target = new File(folder, localFileName(file.filename));
  if (target.exists && target.size === file.size) return target.uri;
  const bytes = await api.downloadAttachmentBytes(file.url);
  if (!stillSignedIn(connectionId)) throw new Error('Signed out');
  folder.create({ intermediates: true, idempotent: true });
  target.write(new Uint8Array(bytes));
  // Signing out while this ran has already deleted the folder, so this copy would otherwise outlive it.
  if (!stillSignedIn(connectionId)) {
    connectionFiles(connectionId).delete();
    throw new Error('Signed out');
  }
  return target.uri;
}

/** The system's sheet, which previews a file and offers to save or send it. Nothing leaves unless the person chooses. */
export async function openFile(uri: string, contentType: string, title: string) {
  await Sharing.shareAsync(uri, { mimeType: contentType, dialogTitle: title });
}

export type Picked = { uri: string; name: string; contentType: string };

export async function pickPhoto(): Promise<Picked | null> {
  // The system's photo picker runs apart from the app, and needs no access to the library.
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    // Encoding the picture again is what removes its metadata, including where it was taken. Visitors see these files.
    quality: 0.85,
    exif: false,
  });
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return null;
  const contentType = asset.mimeType ?? 'image/jpeg';
  return { uri: asset.uri, name: uploadFileName(asset.fileName, contentType), contentType };
}

/** iOS hands the app its own copy of the document in tmp, not the original. Another copy would only be one more to delete. */
export async function pickDocument(): Promise<Picked | null> {
  const result = await DocumentPicker.getDocumentAsync({ type: PICKABLE_TYPES, copyToCacheDirectory: false, multiple: false });
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return null;
  const contentType = asset.mimeType ?? 'application/octet-stream';
  return { uri: asset.uri, name: uploadFileName(asset.name, contentType), contentType };
}

export class TooLarge extends Error {}

/** Both pickers hand over a private copy. It is removed either way, because signing out only clears the connection's folder. */
export async function uploadPicked(api: ApiClient, workspaceId: string, conversationId: string, picked: Picked): Promise<Attachment> {
  const file = new File(picked.uri);
  try {
    if (file.size > MAX_UPLOAD_BYTES) throw new TooLarge();
    return await api.uploadAttachmentBytes(workspaceId, conversationId, { filename: picked.name, contentType: picked.contentType, data: await file.bytes() });
  } finally {
    if (isPrivateCopy(picked.uri) && file.exists) file.delete();
  }
}
