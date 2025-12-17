import random
import string

def generate_codes(num_codes=10000, code_length=6):
    alphabet = string.ascii_uppercase  # A-Z
    codes = set()

    while len(codes) < num_codes:
        code = ''.join(random.sample(alphabet, code_length))
        codes.add(code)

    return list(codes)

if __name__ == "__main__":
    codes = generate_codes()

    # Print codes (or write to a file)
    for c in codes:
        print(c)
