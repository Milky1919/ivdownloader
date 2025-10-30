document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('download_form');
    const testButton = document.getElementById('test_button');
    const batchButton = document.getElementById('batch_button');
    const statusArea = document.getElementById('status_area');

    // Helper function to update status
    const updateStatus = (message, isError = false) => {
        statusArea.textContent = message;
        statusArea.style.color = isError ? 'red' : 'black';
    };

    // Helper function to handle fetch response for file download
    const handleFileResponse = async (response) => {
        if (!response.ok) {
            try {
                const errorData = await response.json();
                throw new Error(errorData.error || 'An unknown error occurred.');
            } catch (jsonError) {
                // If the response is not JSON, use the status text.
                throw new Error(`Server returned an error: ${response.status} ${response.statusText}`);
            }
        }

        const disposition = response.headers.get('content-disposition');
        let filename = 'downloaded_file';
        if (disposition) {
            const utf8FilenameMatch = disposition.match(/filename\*=UTF-8''(.+)/);
            if (utf8FilenameMatch && utf8FilenameMatch[1]) {
                filename = decodeURIComponent(utf8FilenameMatch[1]);
            } else {
                const asciiFilenameMatch = disposition.match(/filename="(.+?)"/);
                if (asciiFilenameMatch && asciiFilenameMatch[1]) {
                    filename = asciiFilenameMatch[1];
                }
            }
        }

        const failedPagesHeader = response.headers.get('X-Failed-Pages');

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);

        return { failedPagesHeader };
    };

    // Test Download Logic
    testButton.addEventListener('click', async () => {
        const formData = new FormData(form);
        const groupName = formData.get('group_name');
        const pdfId = formData.get('pdf');
        const pageRange = formData.get('page_range');
        const firstPage = pageRange ? pageRange.split('-')[0].trim() : null;

        if (!groupName || !pdfId || !firstPage) {
            updateStatus('Please fill in Group Name, PDF ID, and Page Range.', true);
            return;
        }

        const data = {
            group_name: groupName,
            pdf: pdfId,
            page: parseInt(firstPage, 10),
            selector: formData.get('selector')
        };

        updateStatus(`Downloading test page ${data.page}...`);

        try {
            const response = await fetch('/api/download-single', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            await handleFileResponse(response);
            updateStatus(`Successfully downloaded page ${data.page}.`);
        } catch (error) {
            updateStatus(`Error: ${error.message}`, true);
        }
    });

    // Batch Download Logic
    batchButton.addEventListener('click', async () => {
        const formData = new FormData(form);
        const data = {
            group_name: formData.get('group_name'),
            pdf: formData.get('pdf'),
            page_range: formData.get('page_range'),
            selector: formData.get('selector'),
            output_format: formData.get('output_format')
        };

        if (!data.group_name || !data.pdf || !data.page_range) {
             updateStatus('Please fill in all required fields.', true);
             return;
        }

        updateStatus('Starting batch download... This may take a while.');

        try {
            const response = await fetch('/api/download-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });

            const { failedPagesHeader } = await handleFileResponse(response);

            let statusMessage = 'Batch download completed successfully!';
            if (failedPagesHeader) {
                try {
                    const failedPages = JSON.parse(failedPagesHeader);
                    if (failedPages.length > 0) {
                        statusMessage += `\n\nWarning: Could not download the following pages:`;
                        failedPages.forEach(p => {
                            statusMessage += `\n- Page ${p.page}: ${p.reason}`;
                        });
                    }
                } catch (e) {
                     statusMessage += `\n\nWarning: Could not parse failed pages data.`;
                }
            }
            updateStatus(statusMessage);

        } catch (error) {
            updateStatus(`Error: ${error.message}`, true);
        }
    });
});
