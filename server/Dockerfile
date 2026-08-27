FROM python:3.13-alpine
WORKDIR /app
COPY server.py .
RUN adduser -D app && mkdir -p /data && chown app:app /data
USER app
EXPOSE 8080
CMD ["python", "server.py"]
