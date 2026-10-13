
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 5501

CMD ["gunicorn", "--chdir", "server", "--bind", "0.0.0.0:5501", "--workers", "1", "--timeout", "300", "server:app"]
