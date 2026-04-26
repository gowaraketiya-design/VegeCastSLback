# FROM node:18

# # Install Python + venv
# RUN apt-get update && apt-get install -y python3 python3-venv python3-pip

# WORKDIR /app

# # Copy all files
# COPY . .

# # Create virtual environment
# RUN python3 -m venv /opt/venv
# ENV PATH="/opt/venv/bin:$PATH"

# # Install dependencies
# RUN npm install
# RUN pip install -r requirements_new.txt

# # Start backend
# CMD ["node", "src/server.js"]

FROM node:18-slim

# Install Python (minimal)
RUN apt-get update && apt-get install -y python3 python3-venv python3-pip \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

# Create venv
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install deps
RUN npm install
RUN pip install --no-cache-dir -r requirements_new.txt

CMD ["node", "src/server.js"]