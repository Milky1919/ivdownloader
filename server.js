const express = require('express');
const cors = require('cors');
const path = require('path');

const puppeteer = require('puppeteer');
const archiver = require('archiver');
const { PDFDocument, rgb } = require('pdf-lib');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Helper Functions ---

/**
 * Fetches the Base64 source of an image from a given URL using Puppeteer.
 * @param {object} puppeteerPage - The Puppeteer page object.
 * @param {string} url - The URL to navigate to.
 * @param {string} selector - The CSS selector for the image.
 * @returns {Promise<string|null>} The Base64 image string or null if not found.
 */
const getImageBase64 = async (puppeteerPage, url, selector) => {
    // 'domcontentloaded' is often more reliable for SPAs or pages with embedded content
    // as it doesn't wait for all network requests to finish.
    await puppeteerPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await puppeteerPage.waitForSelector(selector, { timeout: 30000 });
    return puppeteerPage.evaluate((sel) => {
        const img = document.querySelector(sel);
        return img ? img.src : null;
    }, selector);
};

/**
 * Parses a string representing a page range (e.g., "1-10", "5") into an array of numbers.
 * @param {string} rangeStr - The page range string.
 * @returns {number[]} An array of page numbers.
 */
const parsePageRange = (rangeStr) => {
    if (rangeStr.includes('-')) {
        const [start, end] = rangeStr.split('-').map(Number);
        if (isNaN(start) || isNaN(end) || start > end) return [];
        return Array.from({ length: end - start + 1 }, (_, i) => start + i);
    }
    const page = Number(rangeStr);
    return isNaN(page) ? [] : [page];
};

/**
 * Extracts components from a Base64 data URI.
 * @param {string} dataURI - The Base64 data URI.
 * @returns {{mimeType: string, extension: string, data: string}|null}
 */
const parseDataURI = (dataURI) => {
    const match = dataURI.match(/^data:(image\/(.+?));base64,(.*)$/);
    if (!match) return null;

    const mimeType = match[1];
    let extension = match[2];
    // Handle complex mime types like 'svg+xml' -> 'svg'
    if (extension.includes('+')) {
        extension = extension.split('+')[0];
    }
     // Simple sanitization
    extension = extension.replace(/[^a-zA-Z0-9]/g, '');

    return { mimeType, extension, data: match[3] };
};


// --- API Endpoints ---

// Test download endpoint
app.post('/api/download-single', async (req, res) => {
    const { group_name, pdf, page, selector } = req.body;

    if (!group_name || !pdf || !page || !selector) {
        return res.status(400).json({ error: 'Missing required parameters.' });
    }

    const url = `https://viewer.impress.co.jp/viewer.html?group_name=${group_name}&pdf=${pdf}&page=${page}`;
    let browser = null;

    try {
        const launchOptions = {};
        // --no-sandbox is required for running in containerized environments (e.g., Docker).
        // Use an environment variable to control this for flexibility.
        if (process.env.PUPPETEER_NO_SANDBOX) {
            launchOptions.args = ['--no-sandbox', '--disable-setuid-sandbox'];
        }
        browser = await puppeteer.launch(launchOptions);
        const puppeteerPage = await browser.newPage();
        const base64Image = await getImageBase64(puppeteerPage, url, selector);

        if (!base64Image) {
            return res.status(404).json({ error: 'Image selector not found or image has no src.' });
        }

        const imageInfo = parseDataURI(base64Image);
        if (!imageInfo) {
            return res.status(500).json({ error: 'Invalid Base64 image format.' });
        }

        const buffer = Buffer.from(imageInfo.data, 'base64');

        res.setHeader('Content-Type', imageInfo.mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="page_${page}.${imageInfo.extension}"`);
        res.send(buffer);

    } catch (error) {
        console.error('Error during single page download:', error);
        res.status(500).json({ error: `An error occurred: ${error.message}` });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
});

// Batch download endpoint
app.post('/api/download-batch', async (req, res) => {
    const { group_name, pdf, page_range, selector, output_format } = req.body;

    if (!group_name || !pdf || !page_range || !selector || !output_format) {
        return res.status(400).json({ error: 'Missing required parameters.' });
    }

    const pages = parsePageRange(page_range);
    if (pages.length === 0) {
        return res.status(400).json({ error: 'Invalid page range provided.' });
    }

    let browser = null;

    try {
        const launchOptions = {};
        if (process.env.PUPPETEER_NO_SANDBOX) {
            launchOptions.args = ['--no-sandbox', '--disable-setuid-sandbox'];
        }
        browser = await puppeteer.launch(launchOptions);
        const puppeteerPage = await browser.newPage();

        const images = [];
        const failedPages = [];
        for (const page of pages) {
            const url = `https://viewer.impress.co.jp/viewer.html?group_name=${group_name}&pdf=${pdf}&page=${page}`;
            try {
                const base64Image = await getImageBase64(puppeteerPage, url, selector);
                if (base64Image) {
                    images.push({ page, base64Image });
                } else {
                    failedPages.push(page);
                }
                await new Promise(resolve => setTimeout(resolve, 1500)); // Adjusted wait time
            } catch (pageError) {
                console.error(`Failed to fetch page ${page}:`, pageError.message);
                failedPages.push(page);
            }
        }

        if (images.length === 0) {
            return res.status(404).json({ error: 'No images could be downloaded.' });
        }

        // Expose failed pages info to the client
        if (failedPages.length > 0) {
            res.setHeader('X-Failed-Pages', failedPages.join(','));
            res.setHeader('Access-Control-Expose-Headers', 'X-Failed-Pages');
        }

        if (output_format === 'zip') {
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="${group_name}.zip"`);
            const archive = archiver('zip', { zlib: { level: 9 } });
            archive.pipe(res);
            for (const img of images) {
                const imageInfo = parseDataURI(img.base64Image);
                if (imageInfo) {
                    const buffer = Buffer.from(imageInfo.data, 'base64');
                    archive.append(buffer, { name: `page_${img.page}.${imageInfo.extension}` });
                }
            }
            await archive.finalize();

        } else if (output_format === 'pdf') {
            const pdfDoc = await PDFDocument.create();
            for (const img of images) {
                const imageInfo = parseDataURI(img.base64Image);
                if (!imageInfo) continue;

                try {
                    const buffer = Buffer.from(imageInfo.data, 'base64');
                    let image;
                    if (imageInfo.mimeType === 'image/png') {
                        image = await pdfDoc.embedPng(buffer);
                    } else if (imageInfo.mimeType === 'image/jpeg' || imageInfo.mimeType === 'image/jpg') {
                        image = await pdfDoc.embedJpg(buffer);
                    } else {
                        console.warn(`Skipping unsupported image type for PDF: ${imageInfo.mimeType}`);
                        continue; // Skip unsupported types for PDF
                    }

                    const pdfPage = pdfDoc.addPage([image.width, image.height]);
                    pdfPage.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });

                } catch (pdfError) {
                    console.error(`Failed to embed page ${img.page} into PDF:`, pdfError.message);
                }
            }
            const pdfBytes = await pdfDoc.save();
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${group_name}.pdf"`);
            res.send(Buffer.from(pdfBytes));
        }

    } catch (error) {
        console.error('Error during batch download:', error);
        res.status(500).json({ error: `An error occurred: ${error.message}` });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
});


app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
