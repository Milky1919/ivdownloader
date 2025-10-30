document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('download_form');
    const testButton = document.getElementById('test_button');
    const batchButton = document.getElementById('batch_button');
    const statusArea = document.getElementById('status_area');
    const allFormControls = [
        testButton,
        batchButton,
        ...Array.from(form.querySelectorAll('input, button, radio'))
    ];

    // Helper function to enable/disable all UI controls
    const setUIEnabled = (isEnabled) => {
        allFormControls.forEach(control => {
            control.disabled = !isEnabled;
        });
    };

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
        setUIEnabled(false);

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
        } finally {
            setUIEnabled(true);
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
            output_format: formData.get('output_format'),
            clientId: `client-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
        };

        if (!data.group_name || !data.pdf || !data.page_range) {
            updateStatus('Please fill in all required fields.', true);
            return;
        }

        // Setup SSE connection
        const eventSource = new EventSource(`/api/progress?clientId=${data.clientId}`);
        const progressContainer = document.getElementById('progress_container');
        const progressBar = document.getElementById('progress_bar');
        const logArea = document.getElementById('log_area');

        progressContainer.style.display = 'block';
        logArea.innerHTML = ''; // Clear previous logs
        progressBar.value = 0;
        updateStatus('Starting batch download...');
        setUIEnabled(false);

        const closeConnection = () => {
            if (eventSource.readyState !== EventSource.CLOSED) {
                eventSource.close();
            }
            setUIEnabled(true);
            // Hide progress bar after a short delay to allow user to see the final status
            setTimeout(() => {
                progressContainer.style.display = 'none';
            }, 5000);
        };

        eventSource.onmessage = (event) => {
            const progressData = JSON.parse(event.data);
            if (progressData.type === 'progress') {
                progressBar.value = progressData.value;
            } else if (progressData.type === 'log') {
                const logEntry = document.createElement('div');
                logEntry.textContent = progressData.message;
                if (progressData.isError) {
                    logEntry.style.color = 'red';
                }
                logArea.appendChild(logEntry);
                logArea.scrollTop = logArea.scrollHeight; // Auto-scroll
            } else if (progressData.type === 'complete') {
                let statusMessage = 'Batch download processing finished!';
                 if (progressData.failedPages && progressData.failedPages.length > 0) {
                    statusMessage += `\nWarning: Could not download the following pages:`;
                    progressData.failedPages.forEach(p => {
                        statusMessage += `\n- Page ${p.page}: ${p.reason}`;
                    });
                }
                updateStatus(statusMessage);
                closeConnection();
            } else if (progressData.type === 'error') {
                 updateStatus(`An error occurred on the server: ${progressData.message}`, true);
                 closeConnection();
            }
        };

        eventSource.onerror = () => {
            updateStatus('Connection to server progress updates failed. The download may still be running.', true);
            closeConnection();
        };


        try {
            const response = await fetch('/api/download-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            // The actual file download is handled here, after SSE logs are complete.
            await handleFileResponse(response);
        } catch (error) {
            updateStatus(`Error: ${error.message}`, true);
            closeConnection();
        }
    });
});
