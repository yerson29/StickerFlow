import React, { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Modality, Type } from '@google/genai';

// --- Utility Functions ---

/**
 * Converts a Blob object to a Base64 string (without the data URL prefix).
 * @param blob The Blob to convert.
 * @returns A Promise that resolves with the Base64 string.
 */
async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]); // Remove the "data:image/jpeg;base64," prefix
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Converts a Base64 string and MIME type into a data URL.
 * @param base64 The Base64 string.
 * @param mimeType The MIME type of the image (e.g., 'image/png', 'image/jpeg').
 * @returns A data URL string.
 */
function base64ToDataURL(base64: string, mimeType: string): string {
  return `data:${mimeType};base64,${base64}`;
}

/**
 * Resizes an image to a target square size and converts it to WebP format.
 * @param base64Image The Base64 string of the image.
 * @param originalMimeType The original MIME type of the image.
 * @param targetSize The desired square size (width and height). Defaults to 512.
 * @returns A Promise that resolves with the Base64 string of the WebP image.
 */
async function resizeAndConvertToWebp(
  base64Image: string,
  originalMimeType: string,
  targetSize: number = 512,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = targetSize;
      canvas.height = targetSize;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return reject(new Error('Failed to get canvas context.'));
      }

      ctx.clearRect(0, 0, targetSize, targetSize);

      const hRatio = canvas.width / img.width;
      const vRatio = canvas.height / img.height;
      const ratio = Math.min(hRatio, vRatio);
      const centerShift_x = (canvas.width - img.width * ratio) / 2;
      const centerShift_y = (canvas.height - img.height * ratio) / 2;
      ctx.drawImage(
        img,
        0,
        0,
        img.width,
        img.height,
        centerShift_x,
        centerShift_y,
        img.width * ratio,
        img.height * ratio,
      );

      try {
        const webpDataURL = canvas.toDataURL('image/webp', 0.8);
        resolve(webpDataURL.split(',')[1]);
      } catch (error) {
        console.error('Error converting to WebP:', error);
        reject(new Error('Failed to convert image to WebP: ' + error));
      }
    };
    img.onerror = (e) => {
      console.error('Failed to load image for resizing:', e);
      reject(new Error('Failed to load image for resizing.'));
    };
    img.src = base64ToDataURL(base64Image, originalMimeType);
  });
}

/**
 * Downloads a file given its data URL (or blob URL/URI) and desired filename.
 * @param href The URL/URI of the file (e.g., 'data:image/webp;base64,...' or 'blob:...' or 'https://...').
 * @param filename The name for the downloaded file.
 */
function downloadFile(href: string, filename: string) {
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// --- React Component ---

interface Sticker {
  id: string; // Unique ID for key prop
  isAnimated: boolean; // True for video, false for static image

  // If static (isAnimated === false):
  base64?: string; // WebP base64
  mimeType?: string; // 'image/webp'
  originalBase64?: string; // Original data for edits, or last edited WebP if loaded from storage
  originalMimeType?: string; // Original MIME type for edits

  // If animated (isAnimated === true):
  videoDownloadUri?: string; // The Google Cloud URI for direct download of the MP4
  videoMimeType?: string; // 'video/mp4'
  // No thumbnail for now, will show video tag directly
}

interface Template {
  name: string;
  prompt: string;
  icon: string;
}

// Placeholder for initial templates, will be overwritten by generation
const initialViralTemplates: Template[] = []; 

const LOCAL_STORAGE_STICKERS_KEY = 'viralStickersData';

const App: React.FC = () => {
  const [apiKeySelected, setApiKeySelected] = useState<boolean>(false);
  const [prompt, setPrompt] = useState<string>('');
  const [generatedStickers, setGeneratedStickers] = useState<Sticker[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [loadingTemplates, setLoadingTemplates] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [selectedStickerIndex, setSelectedStickerIndex] = useState<number | null>(null);
  const [editPrompt, setEditPrompt] = useState<string>('');
  const [currentTemplates, setCurrentTemplates] = useState<Template[]>(initialViralTemplates);

  const handleAPIError = useCallback(async (e: any, context: string) => {
    console.error(`Error al ${context}:`, e);
    let displayErrorMessage = `Error al ${context}: ${e.message || 'Error desconocido'}`;
    let shouldResetApiKey = false;

    if (e && typeof e === 'object' && e.error && e.error.message) {
      displayErrorMessage = `Error de la API al ${context}: ${e.error.message}`;
      if (e.error.message.includes("API key expired.") || e.error.message.includes("Requested entity was not found.")) {
        shouldResetApiKey = true;
      }
    } else if (e instanceof Error && e.message) {
      if (e.message.includes("API key expired.") || e.message.includes("Requested entity was not found.")) {
        displayErrorMessage = 'Error: La API Key no es válida o ha expirado. Por favor, selecciona una API Key válida.';
        shouldResetApiKey = true;
      }
    } else if (typeof e === 'string') {
      if (e.includes("API key expired.") || e.includes("Requested entity was not found.")) {
        displayErrorMessage = 'Error: La API Key no es válida o ha expirado. Por favor, selecciona una API Key válida.';
        shouldResetApiKey = true;
      } else {
        displayErrorMessage = `Error al ${context}: ${e}`;
      }
    }
    
    setError(displayErrorMessage);
    setInfoMessage(null); // Clear info message on error
    if (shouldResetApiKey) {
      setApiKeySelected(false);
      // Attempt to re-open API key selector if a specific Veo error occurs
      if (e && typeof e === 'object' && e.error && e.error.message && e.error.message.includes("Requested entity was not found.")) {
        await window.aistudio.openSelectKey();
      }
    }
  }, []);

  // --- Local Storage Functions ---
  const saveStickersToLocalStorage = useCallback(() => {
    try {
        const simplifiedStickers = generatedStickers.map(sticker => {
            if (sticker.isAnimated) {
                // For animated, save just the URI and metadata
                return {
                    id: sticker.id,
                    isAnimated: true,
                    videoDownloadUri: sticker.videoDownloadUri, // This is a URL string, small
                    videoMimeType: sticker.videoMimeType,
                };
            } else {
                // For static, save optimized WebP data
                return {
                    id: sticker.id,
                    base64: sticker.base64,
                    mimeType: sticker.mimeType,
                    isAnimated: false, // Explicitly false
                };
            }
        });
        localStorage.setItem(LOCAL_STORAGE_STICKERS_KEY, JSON.stringify(simplifiedStickers));
        setError(null); 
        setInfoMessage('Stickers guardados exitosamente en el navegador!');
    } catch (e: any) { 
        console.error('Error al guardar stickers en localStorage:', e);
        if (e.name === 'QuotaExceededError') {
            setError('Error al guardar stickers: Se ha excedido la cuota de almacenamiento del navegador. Por favor, borra los stickers guardados anteriormente o reduce la cantidad de stickers a guardar.');
        } else {
            setError('Error al guardar stickers en el navegador.');
        }
        setInfoMessage(null);
    }
  }, [generatedStickers]);

  const loadStickersFromLocalStorage = useCallback(() => {
    try {
        const storedStickers = localStorage.getItem(LOCAL_STORAGE_STICKERS_KEY);
        if (storedStickers) {
            const parsedStickers: Sticker[] = JSON.parse(storedStickers);
            const rehydratedStickers = parsedStickers.map(sticker => {
                if (sticker.isAnimated) {
                    // Animated stickers: load direct properties
                    return {
                        id: sticker.id,
                        isAnimated: true,
                        videoDownloadUri: sticker.videoDownloadUri,
                        videoMimeType: sticker.videoMimeType,
                    };
                } else {
                    // Static stickers: rehydrate originalBase64 from base64 if not present
                    return {
                        ...sticker,
                        isAnimated: false, // Ensure isAnimated is explicitly false for static
                        originalBase64: sticker.originalBase64 || sticker.base64,
                        originalMimeType: sticker.originalMimeType || sticker.mimeType,
                    };
                }
            });
            setGeneratedStickers(rehydratedStickers);
            setSelectedStickerIndex(null); 
            setEditPrompt('');
            setError(null);
            setInfoMessage(`Se han cargado ${rehydratedStickers.length} stickers guardados.`);
        } else {
            setError('No hay stickers guardados para cargar.');
            setInfoMessage(null);
        }
    } catch (e) {
        console.error('Error al cargar stickers de localStorage:', e);
        setError('Error al cargar stickers del navegador (posiblemente datos corruptos).');
        setInfoMessage(null);
        localStorage.removeItem(LOCAL_STORAGE_STICKERS_KEY); // Clear corrupt data
    }
  }, []);

  const clearSavedStickers = useCallback(() => {
    if (confirm('¿Estás seguro de que quieres borrar todos los stickers guardados en tu navegador? Esta acción no se puede deshacer.')) {
        try {
            localStorage.removeItem(LOCAL_STORAGE_STICKERS_KEY);
            setGeneratedStickers([]); 
            setSelectedStickerIndex(null);
            setEditPrompt('');
            setError(null);
            setInfoMessage('Stickers guardados borrados.');
        } catch (e) {
            console.error('Error al borrar stickers de localStorage:', e);
            setError('Error al borrar stickers guardados del navegador.');
            setInfoMessage(null);
        }
    }
  }, []);

  const loadInitialData = useCallback(async () => {
    try {
        const hasKey = await window.aistudio.hasSelectedApiKey();
        setApiKeySelected(hasKey);

        if (hasKey && currentTemplates.length === 0) { // Only generate if no templates are loaded yet
            await generateMoreTemplates(true); // Generate templates on initial load
        }
    } catch (e) {
        handleAPIError(e, 'verificar estado de API Key');
        setApiKeySelected(false);
    } finally {
        const storedStickers = localStorage.getItem(LOCAL_STORAGE_STICKERS_KEY);
        if (storedStickers) {
            try {
                const parsedStickers: Sticker[] = JSON.parse(storedStickers);
                const rehydratedStickers = parsedStickers.map(sticker => {
                    if (sticker.isAnimated) {
                        return { ...sticker, isAnimated: true }; 
                    } else {
                        return {
                            ...sticker,
                            isAnimated: false, 
                            originalBase64: sticker.originalBase64 || sticker.base64,
                            originalMimeType: sticker.originalMimeType || sticker.mimeType,
                        };
                    }
                });
                setGeneratedStickers(rehydratedStickers);
            } catch (parseError) {
                console.error('Error parsing stored stickers from localStorage:', parseError);
                setError('Error al cargar stickers guardados (datos corruptos).');
                localStorage.removeItem(LOCAL_STORAGE_STICKERS_KEY); 
            }
        }
    }
}, [handleAPIError, currentTemplates.length]); // Added currentTemplates.length to dependencies

useEffect(() => {
    loadInitialData();
}, [loadInitialData]);


  const handleSelectApiKey = async () => {
    try {
      await window.aistudio.openSelectKey();
      setApiKeySelected(true);
      setError(null);
      setInfoMessage(null);
      // After selecting API key, if templates are empty, generate them
      if (currentTemplates.length === 0) {
        await generateMoreTemplates(true); 
      }
    } catch (e) {
      handleAPIError(e, 'abrir el selector de API Key');
      setApiKeySelected(false);
    }
  };

  const generateMoreTemplates = async (isInitialLoad = false) => {
    if (!apiKeySelected) {
      setError('Por favor, selecciona una API Key antes de generar plantillas.');
      return;
    }

    setLoadingTemplates(true);
    setError(null);
    setInfoMessage(isInitialLoad ? 'Cargando plantillas virales...' : 'Generando 20 plantillas virales nuevas...');

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });
      const templateGenerationPrompt = `Generate 20 unique and highly viral sticker prompt ideas for WhatsApp. Each idea should be a JSON object with 'name' (a short, catchy Spanish name), 'prompt' (a detailed Spanish description for an image generation model, max 100-150 characters), and 'icon' (a single emoji representing the template). Ensure the prompts are diverse, creative, and distinct from typical sticker ideas.
      
      Example format:
      [
        {
          "name": "Perro Confundido",
          "prompt": "Un perro pug con una cara de confusión extrema, una bombilla fundida sobre su cabeza, estilo pixel art.",
          "icon": "🐕"
        },
        {
          "name": "Búho Sabio",
          "prompt": "Un búho con gafas leyendo un libro, sentado en una pila de conocimiento, estilo caricatura educativa.",
          "icon": "🦉"
        }
      ]`;

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: templateGenerationPrompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
             type: Type.ARRAY,
             items: {
               type: Type.OBJECT,
               properties: {
                 name: { type: Type.STRING, description: 'Short, catchy name for the sticker template' },
                 prompt: { type: Type.STRING, description: 'Detailed prompt for image generation, in Spanish, describing a viral sticker idea.' },
                 icon: { type: Type.STRING, description: 'A single emoji representing the template.' },
               },
               required: ['name', 'prompt', 'icon'],
             },
           },
           thinkingConfig: { thinkingBudget: 500 }
        },
      });

      let jsonStr = response.text.trim();
      // Attempt to clean JSON string if it has leading/trailing text
      if (!jsonStr.startsWith('[') && !jsonStr.startsWith('{')) {
          const firstBracket = jsonStr.indexOf('[');
          if (firstBracket !== -1) jsonStr = jsonStr.substring(firstBracket);
      }
      if (!jsonStr.endsWith(']') && !jsonStr.endsWith('}')) {
          const lastBracket = jsonStr.lastIndexOf(']');
          if (lastBracket !== -1) jsonStr = jsonStr.substring(0, lastBracket + 1);
      }
      
      const newTemplates: Template[] = JSON.parse(jsonStr);

      setCurrentTemplates(newTemplates); // <--- Key change: replace, not append
      setInfoMessage(isInitialLoad ? 'Plantillas cargadas con éxito.' : 'Plantillas generadas con éxito.');
    } catch (e) {
      handleAPIError(e, 'generar plantillas');
    } finally {
      setLoadingTemplates(false);
    }
  };


  const generateStickers = async () => {
    if (!prompt.trim()) {
      setError('Por favor, introduce un prompt para generar stickers.');
      return;
    }
    if (!apiKeySelected) {
      setError('Por favor, selecciona una API Key antes de generar stickers.');
      return;
    }

    setLoading(true);
    setError(null);
    setInfoMessage('Generando 5 stickers estáticos... esto puede tardar unos segundos.');
    setGeneratedStickers([]);
    setSelectedStickerIndex(null);
    setEditPrompt('');

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });

      const generationPromises = Array(5).fill(null).map(() => 
        ai.models.generateContent({
          model: 'gemini-2.5-flash-image',
          contents: [{ parts: [{ text: prompt }] }],
          config: {
            responseModalities: [Modality.IMAGE],
          },
        })
      );

      const responses = await Promise.all(generationPromises);
      const newStickers: Sticker[] = [];

      for (const response of responses) {
        const imagePart = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
        if (imagePart && imagePart.data && imagePart.mimeType) {
          const processedBase64 = await resizeAndConvertToWebp(
            imagePart.data,
            imagePart.mimeType,
          );
          newStickers.push({
            id: crypto.randomUUID(),
            isAnimated: false, 
            base64: processedBase64,
            mimeType: 'image/webp',
            originalBase64: imagePart.data,
            originalMimeType: imagePart.mimeType,
          });
        }
      }

      if (newStickers.length === 0) {
        setError('No se pudieron generar stickers. Inténtalo con un prompt diferente.');
        setInfoMessage(null);
      } else {
        setInfoMessage('¡Stickers estáticos generados con éxito!');
      }
      setGeneratedStickers(newStickers);
    } catch (e) {
      handleAPIError(e, 'generar stickers');
    } finally {
      setLoading(false);
    }
  };

  const generateAnimatedSticker = async () => {
    if (!prompt.trim()) {
      setError('Por favor, introduce un prompt para generar el sticker animado.');
      return;
    }
    if (!apiKeySelected) {
      setError('La generación de stickers animados (video) requiere que selecciones una API Key. La API de Gemini para generación de video (`Veo`) tiene costos asociados a su uso. Por favor, selecciona una API Key válida.');
      await handleSelectApiKey(); // Attempt to open key selector
      if (!apiKeySelected) return; 
    }

    setLoading(true);
    setError(null);
    setInfoMessage('Generando sticker animado (video MP4)... Esto puede tardar varios minutos. Por favor, no cierres la página.');

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });

      // Start video generation
      let operation = await ai.models.generateVideos({
        model: 'veo-3.1-fast-generate-preview',
        prompt: prompt, 
        config: {
          numberOfVideos: 1,
          resolution: '720p',
          aspectRatio: '16:9' 
        }
      });

      // Poll for completion
      while (!operation.done) {
        setInfoMessage('Generando sticker animado (video MP4)... Esto puede tardar varios minutos. Por favor, no cierres la página.');
        await new Promise(resolve => setTimeout(resolve, 10000)); 
        const updatedAi = new GoogleGenAI({ apiKey: process.env.API_KEY! });
        operation = await updatedAi.operations.getVideosOperation({ operation: operation });
      }

      const downloadLink = operation.response?.generatedVideos?.[0]?.video?.uri;
      if (downloadLink) {
        const newAnimatedSticker: Sticker = {
          id: crypto.randomUUID(),
          isAnimated: true,
          videoDownloadUri: downloadLink,
          videoMimeType: 'video/mp4',
        };
        setGeneratedStickers((prev) => [...prev, newAnimatedSticker]);
        setError(null); 
        setInfoMessage('¡Sticker animado (MP4) generado con éxito! Puedes descargarlo.');
      } else {
        setError('No se pudo generar el sticker animado. Inténtalo con un prompt diferente.');
        setInfoMessage(null);
      }
    } catch (e: any) {
      handleAPIError(e, 'generar sticker animado');
      setInfoMessage(null);
      if (e && typeof e === 'object' && e.error && e.error.message && e.error.message.includes("Requested entity was not found.")) {
        setApiKeySelected(false); 
      }
    } finally {
      setLoading(false);
    }
  };


  const editSticker = async () => {
    if (selectedStickerIndex === null || !generatedStickers[selectedStickerIndex]) {
      setError('No hay un sticker seleccionado para editar.');
      return;
    }
    const stickerToEdit = generatedStickers[selectedStickerIndex];
    if (stickerToEdit.isAnimated) {
      setError('No se pueden editar stickers animados directamente. Esta función es solo para imágenes estáticas.');
      return;
    }

    if (!editPrompt.trim()) {
      setError('Por favor, introduce un prompt para editar el sticker.');
      return;
    }
    if (!apiKeySelected) {
      setError('Por favor, selecciona una API Key antes de editar stickers.');
      return;
    }

    setLoading(true);
    setError(null);
    setInfoMessage('Aplicando edición al sticker seleccionado...');


    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: {
          parts: [
            {
              inlineData: {
                data: stickerToEdit.originalBase64 || stickerToEdit.base64!,
                mimeType: stickerToEdit.originalMimeType || stickerToEdit.mimeType!,
              },
            },
            { text: editPrompt },
          ],
        },
        config: {
          responseModalities: [Modality.IMAGE],
        },
      });

      const imagePart = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
      if (imagePart && imagePart.data && imagePart.mimeType) {
        const processedBase64 = await resizeAndConvertToWebp(
          imagePart.data,
          imagePart.mimeType,
        );
        const updatedStickers = [...generatedStickers];
        updatedStickers[selectedStickerIndex] = {
          id: stickerToEdit.id, 
          isAnimated: false,
          base64: processedBase64,
          mimeType: 'image/webp',
          originalBase64: imagePart.data, 
          originalMimeType: imagePart.mimeType,
        };
        setGeneratedStickers(updatedStickers);
        setInfoMessage('¡Edición aplicada con éxito!');
      } else {
        setError('No se pudo editar el sticker. Inténtalo de nuevo.');
        setInfoMessage(null);
      }
    } catch (e) {
      handleAPIError(e, 'editar sticker');
      setInfoMessage(null);
    } finally {
      setLoading(false);
    }
  };

  const removeBackground = async () => {
    if (selectedStickerIndex === null || !generatedStickers[selectedStickerIndex]) {
      setError('No hay un sticker seleccionado para eliminar el fondo.');
      return;
    }
    const stickerToEdit = generatedStickers[selectedStickerIndex];
    if (stickerToEdit.isAnimated) {
      setError('No se puede eliminar el fondo de stickers animados. Esta función es solo para imágenes estáticas.');
      return;
    }

    if (!apiKeySelected) {
      setError('Por favor, selecciona una API Key antes de eliminar el fondo.');
      return;
    }

    setLoading(true);
    setError(null);
    setInfoMessage('Eliminando el fondo del sticker seleccionado...');


    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: {
          parts: [
            {
              inlineData: {
                data: stickerToEdit.originalBase64 || stickerToEdit.base64!,
                mimeType: stickerToEdit.originalMimeType || stickerToEdit.mimeType!,
              },
            },
            { text: 'remove the background from this image' }, 
          ],
        },
        config: {
          responseModalities: [Modality.IMAGE],
        },
      });

      const imagePart = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
      if (imagePart && imagePart.data && imagePart.mimeType) {
        const processedBase64 = await resizeAndConvertToWebp(
          imagePart.data,
          imagePart.mimeType,
        );
        const updatedStickers = [...generatedStickers];
        updatedStickers[selectedStickerIndex] = {
          id: stickerToEdit.id, 
          isAnimated: false,
          base64: processedBase64,
          mimeType: 'image/webp',
          originalBase64: imagePart.data, 
          originalMimeType: imagePart.mimeType,
        };
        setGeneratedStickers(updatedStickers);
        setInfoMessage('¡Fondo eliminado con éxito!');
      } else {
        setError('No se pudo eliminar el fondo del sticker. Inténtalo de nuevo.');
        setInfoMessage(null);
      }
    } catch (e) {
      handleAPIError(e, 'eliminar fondo del sticker');
      setInfoMessage(null);
    } finally {
      setLoading(false);
    }
  };

  const downloadSingleSticker = async (sticker: Sticker, index: number) => {
    setInfoMessage(`Preparando descarga de sticker ${index + 1}...`);
    try {
      if (sticker.isAnimated && sticker.videoDownloadUri) {
        const response = await fetch(`${sticker.videoDownloadUri}&key=${process.env.API_KEY!}`);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        downloadFile(blobUrl, `sticker_animado_viral_${index + 1}.mp4`);
        URL.revokeObjectURL(blobUrl); 
        setInfoMessage(`Sticker animado ${index + 1} descargado.`);
      } else if (!sticker.isAnimated && sticker.base64 && sticker.mimeType) {
        const dataURL = base64ToDataURL(sticker.base64, sticker.mimeType);
        downloadFile(dataURL, `sticker_viral_${index + 1}.webp`);
        setInfoMessage(`Sticker estático ${index + 1} descargado.`);
      } else {
        setError('No se pudo descargar el sticker. Información faltante.');
        setInfoMessage(null);
      }
    } catch (e) {
      handleAPIError(e, 'descargar sticker');
      setInfoMessage(null);
    }
  };

  const downloadAllStickers = () => {
    if (generatedStickers.length === 0) {
      setError('No hay stickers para descargar.');
      return;
    }
    setInfoMessage('Descargando todos los stickers...');
    generatedStickers.forEach((sticker, index) => {
      downloadSingleSticker(sticker, index);
    });
    setInfoMessage(
      'Se han descargado todos tus stickers. ' +
      'Para usarlos como un paquete en WhatsApp, necesitarás una aplicación de terceros ' +
      'que permita crear packs de stickers a partir de tus imágenes/videos (ej. "Sticker Maker Studio"). ' +
      'Los stickers animados se descargan como MP4, compatibles con WhatsApp.'
    );
  };

  const handleTemplateSelect = (templatePrompt: string) => {
    setPrompt(templatePrompt);
    document.getElementById('prompt-input')?.focus();
    setInfoMessage(`Plantilla "${templatePrompt}" seleccionada.`);
  };

  const selectedSticker = selectedStickerIndex !== null ? generatedStickers[selectedStickerIndex] : null;
  const selectedStickerIsAnimated = selectedSticker?.isAnimated || false;

  return (
    <div className="app-container">
      <header className="app-header">
        <h1>StickerFlow <span>Viraliza tus Ideas</span></h1>
      </header>

      {!apiKeySelected && (
        <div className="section-container api-key-prompt fade-in">
          <p>
            ¡Bienvenido a StickerFlow! Para comenzar a crear, por favor, selecciona una API Key de Gemini.
            La API de Gemini tiene costos asociados; puedes ver la
            <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noopener noreferrer">
              documentación de facturación aquí
            </a>.
          </p>
          <button onClick={handleSelectApiKey} aria-label="Seleccionar API Key">
            <span className="icon">🔑</span> Seleccionar API Key
          </button>
        </div>
      )}

      {error && <div className="message-container error-message fade-in" role="alert">{error}</div>}
      {infoMessage && <div className="message-container info-info fade-in" role="status">{infoMessage}</div>} {/* Changed to info-info for styling */}

      {apiKeySelected && (
        <div className="main-content-wrapper">
          {/* Left Column: Templates Sidebar */}
          <aside className="templates-sidebar fade-in">
            <div className="section-container templates-list-container">
              <h2>Plantillas Virales <span className="icon">✨</span></h2>
              <p>Inspírate con estas ideas. ¡Un clic y estarán listas para usar!</p>
              <div className="template-grid">
                {currentTemplates.map((template, index) => (
                  <button
                    key={`${template.name}-${index}`}
                    className="template-card"
                    onClick={() => handleTemplateSelect(template.prompt)}
                    aria-label={`Seleccionar plantilla: ${template.name}`}
                    title={template.prompt}
                  >
                    <span className="template-icon">{template.icon}</span>
                    <span className="template-name">{template.name}</span>
                    <p className="template-prompt-preview">{template.prompt}</p>
                  </button>
                ))}
              </div>
              <div className="btn-group" style={{ marginTop: '30px' }}>
                <button onClick={() => generateMoreTemplates(false)} disabled={loadingTemplates || !apiKeySelected} aria-label="Generar más plantillas">
                  {loadingTemplates ? 'Generando Plantillas...' : <><span className="icon">🔄</span> Regenerar 20 Plantillas</>}
                </button>
              </div>
              {loadingTemplates && <div className="loading-spinner small" aria-label="Cargando plantillas"></div>} {/* Added small class */}
            </div>
          </aside>

          {/* Right Column: Main App Sections */}
          <main className="app-main-sections">
            <div className="section-container fade-in">
              <h2>Crea tu Sticker <span className="icon">✍️</span></h2>
              <label htmlFor="prompt-input">Describe el sticker de tus sueños (ej. "un mapache haciendo parkour en la luna, estilo cyberpunk")</label>
              <textarea
                id="prompt-input"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Sé creativo/a, ¡el límite es tu imaginación!"
                rows={4}
                aria-label="Introduce tu prompt para generar stickers"
              />
              <div className="btn-group">
                <button onClick={generateStickers} disabled={loading || !prompt.trim() || !apiKeySelected} aria-label="Generar Stickers Estáticos">
                  {loading ? 'Generando Estáticos...' : <><span className="icon">🖼️</span> Generar 5 Stickers Estáticos</>}
                </button>
                <button onClick={generateAnimatedSticker} disabled={loading || !prompt.trim() || !apiKeySelected} className="btn-animated" aria-label="Generar Sticker Animado (MP4)">
                  {loading ? 'Generando Animado...' : <><span className="icon">🎬</span> Generar Sticker Animado (MP4)</>}
                </button>
              </div>
            </div>

            {loading && <div className="loading-spinner large" aria-label="Cargando stickers"></div>}

            {generatedStickers.length > 0 && (
              <div className="section-container fade-in">
                <h2>Tus Creaciones <span className="icon">🎨</span></h2>
                <div className="btn-group" style={{ marginBottom: '30px' }}>
                  <button onClick={downloadAllStickers} disabled={loading} aria-label="Descargar todos los stickers" className="btn-download-all">
                    <span className="icon">⬇️</span> Descargar Todos
                  </button>
                </div>
                <div className="sticker-grid">
                  {generatedStickers.map((sticker, index) => (
                    <div
                      key={sticker.id}
                      className={`sticker-card ${selectedStickerIndex === index ? 'selected' : ''}`}
                      role="group"
                      aria-label={`Sticker generado ${index + 1}`}
                    >
                      {sticker.isAnimated ? (
                        sticker.videoDownloadUri ? (
                          <video 
                            src={`${sticker.videoDownloadUri}&key=${process.env.API_KEY!}`} 
                            controls 
                            autoPlay 
                            loop 
                            muted 
                            className="sticker-visual transparent-background"
                            aria-label={`Sticker animado ${index + 1}`}
                            title={`Sticker animado ${index + 1}`}
                          >
                            Tu navegador no soporta videos.
                          </video>
                        ) : (
                          <div className="sticker-visual video-placeholder transparent-background">Cargando video...</div>
                        )
                      ) : (
                        <img src={base64ToDataURL(sticker.base64!, sticker.mimeType!)} alt={`Sticker ${index + 1}`} className="sticker-visual transparent-background" />
                      )}
                      
                      <div className="sticker-actions">
                        <button
                          className="btn-action btn-download-single"
                          onClick={() => downloadSingleSticker(sticker, index)}
                          disabled={loading}
                          aria-label={`Descargar sticker ${index + 1}`}
                        >
                          <span className="icon">💾</span> Descargar
                        </button>
                        <button
                          className="btn-action btn-edit-single"
                          onClick={() => setSelectedStickerIndex(index)}
                          disabled={loading || sticker.isAnimated} 
                          aria-label={`Editar sticker ${index + 1}`}
                        >
                          {sticker.isAnimated ? 'No Editable' : <><span className="icon">✏️</span> Editar</>}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {selectedStickerIndex !== null && selectedSticker && (
                  <div className="section-container fade-in" style={{ marginTop: '50px' }}>
                    <h3>Editar Sticker #<span className="primary-text-highlight">{selectedStickerIndex + 1}</span> <span className="icon">✂️</span></h3>
                    {selectedStickerIsAnimated ? (
                      <p className="info-message">La edición en la app no está disponible para stickers animados. Descárgalo para editar con herramientas externas.</p>
                    ) : (
                      <>
                        <label htmlFor="edit-prompt-input">¿Cómo quieres transformarlo? (ej. "ponle un sombrero de vaquero y gafas de sol")</label>
                        <input
                          id="edit-prompt-input"
                          type="text"
                          value={editPrompt}
                          onChange={(e) => setEditPrompt(e.target.value)}
                          placeholder="Describe tu edición aquí..."
                          aria-label="Introduce tu prompt para editar el sticker"
                        />
                        <div className="btn-group" style={{marginTop: '20px'}}>
                          <button onClick={editSticker} disabled={loading || !editPrompt.trim() || !apiKeySelected} aria-label="Aplicar edición" className="btn-edit-apply">
                            {loading ? 'Aplicando Edición...' : <><span className="icon">✅</span> Aplicar Edición</>}
                          </button>
                          <button
                            onClick={removeBackground}
                            disabled={loading || !apiKeySelected}
                            className="btn-remove-bg"
                            aria-label="Eliminar el fondo del sticker"
                          >
                            {loading ? 'Eliminando Fondo...' : <><span className="icon">✂️</span> Eliminar Fondo</>}
                          </button>
                        </div>
                      </>
                    )}
                    
                    <div className="whatsapp-preview-section">
                      <h4>Previsualización en WhatsApp <span className="icon">💬</span></h4>
                      <div className="whatsapp-chat-preview-container">
                          <div className="chat-message recipient">
                              <span>¡Mira qué chulo! 👇</span>
                          </div>
                          <div className="chat-message sender">
                              <div className="chat-sticker-wrapper transparent-background">
                                  {selectedSticker.isAnimated ? (
                                      selectedSticker.videoDownloadUri ? (
                                          <video 
                                              src={`${selectedSticker.videoDownloadUri}&key=${process.env.API_KEY!}`} 
                                              autoPlay 
                                              loop 
                                              muted 
                                              className="chat-sticker-preview"
                                              aria-label="Previsualización de sticker animado"
                                          >
                                              Tu navegador no soporta videos.
                                          </video>
                                      ) : (
                                          <div className="chat-sticker-preview video-placeholder"></div>
                                      )
                                  ) : (
                                      <img 
                                          src={base64ToDataURL(selectedSticker.base64!, selectedSticker.mimeType!)} 
                                          alt="Previsualización del sticker" 
                                          className="chat-sticker-preview"
                                      />
                                  )}
                              </div>
                          </div>
                          <div className="chat-message recipient">
                              <span>¡Me encanta! ¡Directo a mi colección de virales! 😄</span>
                          </div>
                      </div>
                    </div>

                    <button
                      onClick={() => {
                        setSelectedStickerIndex(null);
                        setEditPrompt('');
                        setInfoMessage('Edición cancelada.');
                      }}
                      disabled={loading}
                      className="btn-cancel-edit"
                      style={{ marginTop: '30px' }}
                      aria-label="Cancelar edición"
                    >
                      <span className="icon">❌</span> Cancelar Edición
                    </button>
                  </div>
                )}
              </div>
            )}

            <div className="section-container fade-in">
              <h2>Gestiona tus Stickers <span className="icon">🗃️</span></h2>
              <p>Guarda tus creaciones en el navegador, cárgalas o bórralas.</p>
              <div className="btn-group">
                  <button onClick={saveStickersToLocalStorage} disabled={loading || generatedStickers.length === 0} aria-label="Guardar stickers" className="btn-save">
                      <span className="icon">📥</span> Guardar Stickers
                  </button>
                  <button onClick={loadStickersFromLocalStorage} disabled={loading} aria-label="Cargar stickers guardados" className="btn-load">
                      <span className="icon">📤</span> Cargar Guardados
                  </button>
                  <button onClick={clearSavedStickers} disabled={loading} aria-label="Borrar stickers guardados" className="btn-clear-saved">
                      <span className="icon">🗑️</span> Borrar Guardados
                  </button>
              </div>
            </div>
          </main>
        </div>
      )}
      <footer className="app-footer fade-in">
        <p>© 2024 StickerFlow - Desarrollado con ❤️ y Gemini API</p>
      </footer>
    </div>
  );
};

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}