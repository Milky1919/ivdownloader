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
    await puppeteerPage.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
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


// --- API Endpoints ---

// Test download endpoint
app.post('/api/download-single', async (req, res) => {
    const { group_name, pdf, page, selector } = req.body;

    if (!group_name || !pdf || !page || !selector) {
        return res.status(400).json({ error: 'Missing required parameters.' });
    }

    const url = `https://viewer.impress.co.jp/books/${group_name}/${pdf}/index.html?page=${page}`;
    let browser = null;

    try {
        browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const puppeteerPage = await browser.newPage();
        const base64Image = await getImageBase64(puppeteerPage, url, selector);

        if (!base64Image) {
            return res.status(404).json({ error: 'Image selector not found or image has no src.' });
        }

        const matches = base64Image.match(/^data:(image\/([a-zA-Z]+));base64,(.*)$/);
        if (!matches || matches.length !== 4) {
             return res.status(500).json({ error: 'Invalid Base64 image format.' });
        }

        const imageMimeType = `image/${matches[2]}`;
        const imageData = matches[3];
        const buffer = Buffer.from(imageData, 'base64');

        res.setHeader('Content-Type', imageMimeType);
        res.setHeader('Content-Disposition', `attachment; filename="page_${page}.${matches[2]}"`);
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
        browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const puppeteerPage = await browser.newPage();

        const images = [];
        for (const page of pages) {
            const url = `https://viewer.impress.co.jp/books/${group_name}/${pdf}/index.html?page=${page}`;
            try {
                const base64Image = await getImageBase64(puppeteerPage, url, selector);
                if (base64Image) {
                    images.push({ page, base64Image });
                }
                await new Promise(resolve => setTimeout(resolve, 2000));
            } catch (pageError) {
                console.error(`Failed to fetch page ${page}:`, pageError.message);
            }
        }

        if (images.length === 0) {
            return res.status(404).json({ error: 'No images could be downloaded.' });
        }

        if (output_format === 'zip') {
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="${group_name}.zip"`);
            const archive = archiver('zip', { zlib: { level: 9 } });
            archive.pipe(res);
            for (const img of images) {
                const matches = img.base64Image.match(/^data:image\/([a-zA-Z]+);base64,(.*)$/);
                if (matches) {
                    const imageType = matches[1];
                    const buffer = Buffer.from(matches[2], 'base64');
                    archive.append(buffer, { name: `page_${img.page}.${imageType.split('/')[1]}` });
                }
            }
            await archive.finalize();

        } else if (output_format === 'pdf') {
            const pdfDoc = await PDFDocument.create();
            for (const img of images) {
                const matches = img.base64Image.match(/^data:image\/([a-zA-Z]+);base64,(.*)$/);
                if (matches) {
                    const imageType = matches[1];
                    const buffer = Buffer.from(matches[2], 'base64');

                    let image;
                    if (imageType === 'image/png') {
                         image = await pdfDoc.embedPng(buffer);
                    } else {
                         image = await pdfDoc.embedJpg(buffer);
                    }

                    const page = pdfDoc.addPage([image.width, image.height]);
                    page.drawImage(image, {
                        x: 0,
                        y: 0,
                        width: image.width,
                        height: image.height,
                    });
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
