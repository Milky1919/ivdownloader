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
            const errorData = await response.json();
            throw new Error(errorData.error || 'Unknown error occurred.');
        }
        const disposition = response.headers.get('content-disposition');
        const filename = disposition
            ? disposition.split('filename=')[1].replace(/"/g, '')
            : 'downloaded_file';

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
    };

    // Test Download Logic
    testButton.addEventListener('click', async () => {
        const formData = new FormData(form);
        const pageRange = formData.get('page_range');
        const firstPage = pageRange ? pageRange.split('-')[0] : null;

        if (!firstPage) {
            updateStatus('Please enter a valid page or page range.', true);
            return;
        }

        const data = {
            group_name: formData.get('group_name'),
            pdf: formData.get('pdf'),
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
            await handleFileResponse(response);
            updateStatus('Batch download completed successfully!');
        } catch (error) {
            updateStatus(`Error: ${error.message}`, true);
        }
    });
});
