FROM python:3.12-slim

WORKDIR /app

# Dependencies first, so a code change does not re-install them on every build.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Uploaded GeoJSON files land here; docker-compose mounts a volume over it.
ENV UPLOAD_DIR=/data/uploads
RUN mkdir -p /data/uploads

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
