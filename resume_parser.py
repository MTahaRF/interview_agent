from pypdf import PdfReader

def extract_resume_text(file_path: str) -> str:
    """Reads a PDF file and extracts its text."""
    try:
        reader = PdfReader(file_path)
        text = ""
        for page in reader.pages:
            # Extract text from each page and append it
            page_text = page.extract_text()
            if page_text:
                text += page_text + "\n"
        
        return text.strip()
    except Exception as e:
        print(f"Error reading resume PDF: {e}")
        return "No resume provided."
