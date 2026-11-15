FROM dstacktee/dstack-ingress:2.3@sha256:527c53523b9226782a11dbd800a3ff55e8a1f0b88e6224e8f7e4db7419769fbe
COPY prepare_ingress.py /opt/review/prepare_ingress.py
RUN mkdir /custom && python3 /opt/review/prepare_ingress.py && \
    cp /custom/tlsalpn.sh /scripts/tlsalpn.sh && rm -r /custom
